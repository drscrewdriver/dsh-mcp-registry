import { homedir } from "node:os";
import { join } from "node:path";
import fs, { readFileSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/config.ts
const Config$1 = z.object({
	enabled: z.boolean().description("Global switch for the MCP registry and every bridged tool call. Off = mcp_bridge_call refuses and the status tool reports disabled.").volatile(),
	defaultPermissionMode: z.union(["review-all", "allowlist"]).description("Permission mode for connectors that do not set their own. review-all (safe default): every agent call returns needs_review until you grant tools. allowlist: only explicitly granted tools run silently (and read-only-trusted tools when trustReadOnlyHint is on).").volatile(),
	probeTimeoutMs: z.number().min(200).max(3e4).step(100).description("Timeout for one MCP initialize probe (manual, via /mcp-reg probe).").volatile()
});

//#endregion
//#region src/core/ids.ts
/**
* Ids and key-safety helpers.
*
* `sanitizeId` is the single gate for every persisted identifier. Note the
* explicit proto-key denylist: `__proto__` matches the character class, and an
* id is only ever stored as a VALUE, but defense in depth is cheap here — a
* denylisted id can never drift into a record-key position through a future
* refactor.
*/
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** Keys that must never become own-properties via assignment (proto pollution). */
const UNSAFE_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function sanitizeId(raw) {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!ID_RE.test(trimmed)) return null;
	if (UNSAFE_KEYS.has(trimmed.toLowerCase())) return null;
	return trimmed;
}
function isUnsafeKey(key) {
	return UNSAFE_KEYS.has(key);
}
/**
* Assign `key` onto a plain object only when the key is safe. Returns whether
* the assignment happened. Used for every dynamic-key write (toolPermissions,
* env, headers) so a hostile import can never reach the prototype machinery —
* `obj[key] = v` with key `__proto__` silently mutates the prototype instead
* of creating an own property.
*/
function safeAssign(target, key, value) {
	if (isUnsafeKey(key)) return false;
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
	return true;
}
/** Deep check: does any reachable own key of this parsed JSON value look like a proto key? */
function hasUnsafeKeyDeep(value, depth = 0) {
	if (depth > 8 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => hasUnsafeKeyDeep(item, depth + 1));
	for (const key of Object.keys(value)) {
		if (isUnsafeKey(key)) return true;
		if (hasUnsafeKeyDeep(value[key], depth + 1)) return true;
	}
	return false;
}

//#endregion
//#region src/core/store.ts
const SCHEMA_VERSION = 1;
var UnknownConnectorError = class extends Error {
	constructor(id) {
		super(`unknown connector "${id}"`);
	}
};
var DamagedRegistryError = class extends Error {
	constructor(detail) {
		super(`registry is in fail-closed state (${detail}); fix or remove the corrupt file first`);
	}
};
var RegistryStore = class {
	io;
	dir;
	now;
	snapshotLimit;
	filePath;
	state = {
		version: 1,
		generation: 0,
		connectors: []
	};
	loaded = false;
	/** Fail-closed latch: set when the file exists but cannot be parsed. */
	damaged = false;
	damageReason = "";
	corruptFilePath = "";
	constructor(io, opts) {
		this.io = io;
		this.dir = opts.dir;
		this.now = opts.now ?? Date.now;
		this.snapshotLimit = opts.snapshotLimit ?? 20;
		this.filePath = this.join(this.dir, "registry.json");
	}
	join(...parts) {
		return parts.join("/").replace(/\/+/g, "/");
	}
	/** Load once at startup; safe to call again (no-op). */
	load() {
		if (this.loaded) return;
		this.loaded = true;
		const raw = this.io.readFile(this.filePath);
		if (raw === null) return;
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			this.enterFailClosed(`JSON parse failed: ${e.message}`);
			return;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			this.enterFailClosed("top level is not an object");
			return;
		}
		const obj = parsed;
		const version = obj.version;
		if (typeof version !== "number" || !Number.isFinite(version)) {
			this.enterFailClosed("missing schema version");
			return;
		}
		if (version > SCHEMA_VERSION) {
			this.enterFailClosed(`schema version ${version} is newer than supported ${SCHEMA_VERSION}`);
			return;
		}
		if (!Array.isArray(obj.connectors)) {
			this.enterFailClosed("connectors is not an array");
			return;
		}
		this.state = {
			version: 1,
			generation: typeof obj.generation === "number" && Number.isFinite(obj.generation) ? obj.generation : 0,
			connectors: obj.connectors
		};
	}
	enterFailClosed(reason) {
		this.damaged = true;
		this.damageReason = reason;
		this.corruptFilePath = `${this.filePath}.corrupt-${this.now()}`;
		try {
			this.io.rename(this.filePath, this.corruptFilePath);
		} catch {
			this.corruptFilePath = this.filePath;
		}
		this.state = {
			version: 1,
			generation: 0,
			connectors: []
		};
	}
	/** True when the registry refused to load; every connector is then nonexistent. */
	isDamaged() {
		return this.damaged;
	}
	list() {
		return this.damaged ? [] : [...this.state.connectors];
	}
	get(id) {
		if (this.damaged) return void 0;
		return this.state.connectors.find((c) => c.id === id);
	}
	getGeneration() {
		return this.state.generation;
	}
	/**
	* Insert or replace a connector. The replace form is for settings-row
	* round-trips; user-visible edits should go through the field-level
	* mutators so a stale full record cannot clobber newer policy.
	*/
	upsert(record) {
		return this.runSync(() => {
			const idx = this.state.connectors.findIndex((c) => c.id === record.id);
			if (idx >= 0) {
				const previous = this.state.connectors[idx];
				if (!previous) throw new UnknownConnectorError(record.id);
				this.state.connectors[idx] = {
					...record,
					createdAt: previous.createdAt,
					updatedAt: this.now()
				};
				return this.state.connectors[idx];
			}
			this.state.connectors.push(record);
			return record;
		});
	}
	setEnabled(id, enabled) {
		return this.mutateRecord(id, (record) => {
			record.enabled = enabled;
			if (enabled) record.pendingConfirmation = false;
		});
	}
	/** Human confirmation of an imported credential: enables + clears the flag. */
	confirm(id) {
		return this.mutateRecord(id, (record) => {
			record.pendingConfirmation = false;
			record.enabled = true;
		});
	}
	updatePolicy(id, patch) {
		return this.mutateRecord(id, (record) => {
			if (patch.permissionMode !== void 0) record.permissionMode = patch.permissionMode;
			if (patch.toolPermissions !== void 0) {
				const next = {};
				for (const [k, v] of Object.entries(patch.toolPermissions)) safeAssign(next, k, v);
				record.toolPermissions = next;
			}
			if (patch.trustReadOnlyHint !== void 0) record.trustReadOnlyHint = patch.trustReadOnlyHint;
		});
	}
	setAuthToken(id, token) {
		return this.mutateRecord(id, (record) => {
			record.authToken = token;
			record.authType = token ? "bearer" : "none";
		});
	}
	mutateRecord(id, fn) {
		return this.runSync(() => {
			const record = this.state.connectors.find((c) => c.id === id);
			if (!record) throw new UnknownConnectorError(id);
			fn(record);
			record.updatedAt = this.now();
			if (!sanitizeId(record.id)) throw new Error(`connector id became invalid`);
			return record;
		});
	}
	/**
	* Serialize a synchronous mutation and persist it. Every IO call here is
	* synchronous, so a mutation is atomic within one Node turn — there is no
	* await point for a second writer to slip into. If an async IO backend ever
	* replaces StoreFileIo, this method is the single place that must grow a
	* promise-chain mutex.
	*/
	runSync(fn) {
		const result = fn();
		this.persistLocked();
		return result;
	}
	assertHealthy() {
		if (this.damaged) throw new DamagedRegistryError(this.damageReason);
	}
	persistLocked() {
		this.assertHealthy();
		this.state.generation += 1;
		this.io.mkdirp(this.dir);
		this.snapshot();
		const tmp = `${this.filePath}.tmp`;
		const payload = JSON.stringify(this.state, null, 2);
		this.io.writeFile(tmp, payload);
		try {
			this.io.rename(tmp, this.filePath);
		} catch {
			this.io.rmIfExists(this.filePath);
			this.io.rename(tmp, this.filePath);
		}
		const readBack = this.io.readFile(this.filePath);
		if (readBack === null) throw new Error("persist failed: file missing after rename");
		let parsed;
		try {
			parsed = JSON.parse(readBack);
		} catch {
			throw new Error("persist failed: read-back mismatch (file does not parse)");
		}
		if (parsed.generation !== this.state.generation || !Array.isArray(parsed.connectors)) throw new Error("persist failed: read-back mismatch");
	}
	/** Copy the current file aside before overwriting; keep the newest N. */
	snapshot() {
		if (!this.io.exists(this.filePath)) return;
		const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
		const snapshotPath = this.join(this.dir, `registry.${stamp}.bak`);
		const current = this.io.readFile(this.filePath);
		if (current !== null) this.io.writeFile(snapshotPath, current);
		const snapshots = this.io.listDir(this.dir).filter((name$1) => /^registry\..+\.bak$/.test(name$1)).sort();
		for (const name$1 of snapshots.slice(0, Math.max(0, snapshots.length - this.snapshotLimit))) this.io.rm(this.join(this.dir, name$1));
	}
};

//#endregion
//#region src/core/model.ts
/** Error carrying a stable code so UIs can translate without parsing prose. */
var McpRecordError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
const MASK = "********";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PERMISSION_MODES = new Set(["review-all", "allowlist"]);
const TOOL_PERMISSIONS = new Set(["allow", "review"]);
const CAP = {
	id: 64,
	name: 128,
	url: 2048,
	command: 512,
	arg: 512,
	argsCount: 64,
	envEntries: 64,
	envValue: 4096,
	headerEntries: 64,
	token: 4096,
	toolName: 256
};
function normalizePermissionMode(value) {
	return typeof value === "string" && PERMISSION_MODES.has(value) ? value : "review-all";
}
/** Unknown values → undefined (caller falls back to the strictest default). */
function normalizeToolPermission(value) {
	return typeof value === "string" && TOOL_PERMISSIONS.has(value) ? value : void 0;
}
function isLoopbackHost(hostname) {
	const h = hostname.toLowerCase().replace(/\.$/, "");
	return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
/** Redacted target for display: origin only for http, basename for stdio. */
function redactTarget(record) {
	if (record.transport === "streamable-http") try {
		return new URL(record.url).origin;
	} catch {
		return MASK;
	}
	return record.command.split(/[\\/]/).pop() || MASK;
}
function str(value) {
	return typeof value === "string" ? value.trim() : "";
}
function stringRecord(value, keyPattern, errPrefix) {
	if (value === void 0 || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new McpRecordError("record-not-object", `${errPrefix} must be an object`);
	const source = value;
	const entries = Object.keys(source);
	if (entries.length > CAP.envEntries) throw new McpRecordError("too-many-entries", `${errPrefix} exceeds ${CAP.envEntries} entries`);
	const out = {};
	for (const key of entries) {
		if (isUnsafeKey(key) || !keyPattern.test(key)) throw new McpRecordError("invalid-key", `${errPrefix} has an invalid key: ${JSON.stringify(key.slice(0, 32))}`);
		const val = source[key];
		if (typeof val !== "string") throw new McpRecordError("value-not-string", `${errPrefix}.${key} must be a string`);
		if (val.length > CAP.envValue) throw new McpRecordError("value-too-long", `${errPrefix}.${key} exceeds ${CAP.envValue} chars`);
		safeAssign(out, key, val);
	}
	return out;
}
/**
* Normalize one raw connector value (settings row or import entry) into a
* ConnectorRecord. Throws McpRecordError with a stable code on any malformed
* input — this function NEVER silently drops or repairs user data.
*/
function normalizeConnectorInput(id, raw, opts) {
	const safeId = sanitizeId(id);
	if (!safeId) throw new McpRecordError("invalid-id", `connector id ${JSON.stringify(String(id ?? "").slice(0, 32))} is not a valid id ([a-zA-Z0-9_-]{1,64})`);
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new McpRecordError("not-an-object", `connector "${safeId}" must be an object`);
	const rawRec = raw;
	const url = str(rawRec.url);
	const command = str(rawRec.command);
	const typeRaw = str(rawRec.transport) || str(rawRec.type);
	let transport;
	if (typeRaw === "stdio") transport = "stdio";
	else if (typeRaw === "streamable-http" || typeRaw === "streamableHttp" || typeRaw === "streamable-http" || typeRaw === "sse" || typeRaw === "http" || typeRaw === "remote") transport = "streamable-http";
	else if (url) transport = "streamable-http";
	else if (command) transport = "stdio";
	else throw new McpRecordError("no-target", `connector "${safeId}" has neither url nor command`);
	let args = [];
	if (rawRec.args !== void 0 && rawRec.args !== null) {
		if (!Array.isArray(rawRec.args)) throw new McpRecordError("args-not-array", `connector "${safeId}": args must be a JSON array of strings (got ${Array.isArray(rawRec.args) ? "array" : typeof rawRec.args}). A string like "-y mcp-server" is rejected because splitting it silently is how glued-args bugs are born — split it into ["-y", "mcp-server"].`);
		if (rawRec.args.length > CAP.argsCount) throw new McpRecordError("too-many-args", `connector "${safeId}": args exceeds ${CAP.argsCount} entries`);
		args = rawRec.args.map((item, i) => {
			if (typeof item !== "string") throw new McpRecordError("args-non-string", `connector "${safeId}": args[${i}] is ${typeof item}, expected string`);
			if (item.length > CAP.arg) throw new McpRecordError("arg-too-long", `connector "${safeId}": args[${i}] exceeds ${CAP.arg} chars`);
			return item;
		});
	}
	let finalUrl = "";
	let finalCommand = "";
	if (transport === "streamable-http") {
		if (!url) throw new McpRecordError("missing-url", `connector "${safeId}" is missing url`);
		if (url.length > CAP.url) throw new McpRecordError("url-too-long", `connector "${safeId}": url exceeds ${CAP.url} chars`);
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			throw new McpRecordError("invalid-url", `connector "${safeId}": url does not parse`);
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new McpRecordError("url-scheme", `connector "${safeId}": only http/https urls are supported`);
		if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) throw new McpRecordError("http-non-loopback", `connector "${safeId}": plain http is only allowed for loopback hosts; use https for ${parsed.hostname}`);
		finalUrl = url;
	} else {
		if (!command) throw new McpRecordError("missing-command", `connector "${safeId}" is missing command`);
		if (command.length > CAP.command) throw new McpRecordError("command-too-long", `connector "${safeId}": command exceeds ${CAP.command} chars`);
		if (/\s/.test(command) && args.length === 0) throw new McpRecordError("command-has-whitespace", `connector "${safeId}": command contains whitespace and args is empty. Put the executable in command and each argument in the args array — e.g. {"command": "npx", "args": ["-y", "mcp-server-example"]}.`);
		finalCommand = command;
	}
	const toolPermissions = {};
	if (rawRec.toolPermissions !== void 0 && rawRec.toolPermissions !== null) {
		if (typeof rawRec.toolPermissions !== "object" || Array.isArray(rawRec.toolPermissions)) throw new McpRecordError("policy-not-object", `connector "${safeId}": toolPermissions must be an object`);
		for (const [toolName, perm] of Object.entries(rawRec.toolPermissions)) {
			if (!toolName || toolName.length > CAP.toolName) continue;
			const normalized = normalizeToolPermission(perm);
			if (normalized === void 0) continue;
			safeAssign(toolPermissions, toolName, normalized);
		}
	}
	const authToken = str(rawRec.authToken) || str(rawRec.authorizationToken);
	if (authToken.length > CAP.token) throw new McpRecordError("token-too-long", `connector "${safeId}": auth token exceeds ${CAP.token} chars`);
	const authType = str(rawRec.authType) === "bearer" || authToken ? "bearer" : "none";
	const env = stringRecord(rawRec.env, ENV_KEY, `connector "${safeId}" env`);
	const headers = stringRecord(rawRec.headers, HEADER_KEY, `connector "${safeId}" headers`);
	const name$1 = str(rawRec.name) || safeId;
	if (name$1.length > CAP.name) throw new McpRecordError("name-too-long", `connector "${safeId}": name exceeds ${CAP.name} chars`);
	return {
		id: safeId,
		name: name$1,
		transport,
		url: finalUrl,
		command: finalCommand,
		args,
		cwd: str(rawRec.cwd),
		env,
		headers,
		authType,
		authToken,
		enabled: opts.provenance === "import" ? rawRec.enabled === true : rawRec.enabled !== false,
		pendingConfirmation: opts.provenance === "import" ? true : rawRec.pendingConfirmation === true,
		provenance: opts.provenance,
		permissionMode: normalizePermissionMode(rawRec.permissionMode),
		toolPermissions,
		trustReadOnlyHint: rawRec.trustReadOnlyHint === true,
		createdAt: opts.now,
		updatedAt: opts.now,
		schemaVersion: 1
	};
}
function publicView(record) {
	return {
		id: record.id,
		name: record.name,
		transport: record.transport,
		target: redactTarget(record),
		enabled: record.enabled,
		pendingConfirmation: record.pendingConfirmation,
		provenance: record.provenance,
		permissionMode: record.permissionMode,
		grantedTools: Object.keys(record.toolPermissions).filter((k) => record.toolPermissions[k] !== void 0),
		trustReadOnlyHint: record.trustReadOnlyHint
	};
}

//#endregion
//#region src/authz.ts
const NO_EVIDENCE = { listed: false };
function resolveToolAccess(policy, evidence = NO_EVIDENCE) {
	if (policy.permissionMode !== "allowlist") return "review";
	const annotations = evidence.listed && evidence.annotations ? evidence.annotations : null;
	if (annotations?.destructiveHint === true) return "review";
	if (policy.toolPermission === "allow") return "allow";
	if (policy.toolPermission === "review") return "review";
	if (policy.trustReadOnlyHint === true && annotations?.readOnlyHint === true) return "allow";
	return "review";
}
/**
* Merge two annotation listings of the same tool. Merging may only move in
* the direction of MORE scrutiny: a raising hint counts when ANY occurrence
* declares it; a lowering hint only when EVERY occurrence does. An absent
* field says nothing; an explicit `false`/`{}` is a listing that was asked and
* claimed nothing, and it can therefore veto a lowering hint.
*/
function mergeAnnotations(previous, next) {
	if (!previous) return { ...next };
	const merged = {
		...previous,
		...next
	};
	if (previous.destructiveHint === true || next.destructiveHint === true) merged.destructiveHint = true;
	if ("readOnlyHint" in merged) {
		if (previous.readOnlyHint !== true || next.readOnlyHint !== true) merged.readOnlyHint = false;
	}
	return merged;
}

//#endregion
//#region src/client/jsonrpc.ts
let seq = 0;
function nextRequestId() {
	seq += 1;
	return seq;
}
function makeRequest(method, params) {
	const req = {
		jsonrpc: "2.0",
		id: nextRequestId(),
		method
	};
	if (params !== void 0) req.params = params;
	return req;
}
function makeNotification(method, params) {
	const note = {
		jsonrpc: "2.0",
		method
	};
	if (params !== void 0) note.params = params;
	return note;
}
function isRpcResponse(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const msg = value;
	return msg.jsonrpc === "2.0" && ("result" in msg || "error" in msg) && (typeof msg.id === "number" || typeof msg.id === "string" || msg.id === null);
}
function rpcErrorMessage(error) {
	if (!error) return "unknown rpc error";
	return `rpc error ${error.code}: ${error.message}`;
}

//#endregion
//#region src/client/transport-error.ts
/**
* Transport-level failure with a stable code. Error messages carry connector
* id + host:port at most — never a full URL with credentials, never a raw
* fetch exception (those embed the full URL).
*/
var McpTransportError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
function describeFetchFailure(e) {
	if (e instanceof McpTransportError) return e;
	const err = e;
	const code = err?.code ?? err?.cause?.code ?? "";
	if (err?.name === "AbortError" || err?.name === "TimeoutError") return new McpTransportError("timeout", "request timed out");
	if (code === "ECONNREFUSED") return new McpTransportError("connect-failed", "connection refused");
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new McpTransportError("host-unresolved", "host did not resolve");
	return new McpTransportError("connect-failed", `connection failed (${code || err?.name || "unknown"})`);
}
/**
* Extract the JSON-RPC response from one HTTP response body. Streamable-http
* servers MAY answer a single request with `text/event-stream`; when they do,
* the answer for our id is in a `data:` frame, so scan frames in order.
*/
function parseResponseBody(text, contentType) {
	if (/text\/event-stream/i.test(contentType)) {
		for (const frame of text.split(/\r?\n\r?\n/)) {
			const dataLines = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
			if (dataLines.length === 0) continue;
			try {
				return JSON.parse(dataLines.join("\n"));
			} catch {}
		}
		throw new McpTransportError("bad-json", "no parseable data frame in event-stream response");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new McpTransportError("bad-json", "response body is not JSON");
	}
}

//#endregion
//#region src/client/http-client.ts
const PROTOCOL_VERSION = "2024-11-05";
var McpHttpSession = class {
	url;
	headers;
	timeoutMs;
	fetchImpl;
	sessionId = "";
	initialized = false;
	initializing = null;
	info = {};
	constructor(url, opts) {
		this.url = url;
		this.timeoutMs = opts.timeoutMs;
		this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
		this.headers = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...opts.headers
		};
		if (opts.authToken) this.headers["authorization"] = `Bearer ${opts.authToken}`;
	}
	/** Initialize (idempotent, single-flight). Returns honest server info. */
	initialize() {
		if (this.initialized) return Promise.resolve(this.info);
		this.initializing ??= this.doInitialize().finally(() => {
			this.initializing = null;
		});
		return this.initializing;
	}
	async doInitialize() {
		const result = await this.post(makeRequest("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: {
				name: "dsh-mcp-registry",
				version: "0.1.0"
			}
		}));
		const info = {};
		if (result && typeof result === "object") {
			const obj = result;
			if (typeof obj.protocolVersion === "string") info.protocolVersion = obj.protocolVersion;
			const serverInfo = obj.serverInfo;
			if (serverInfo && typeof serverInfo === "object") {
				const si = serverInfo;
				if (typeof si.name === "string") info.serverName = si.name;
				if (typeof si.version === "string") info.serverVersion = si.version;
			}
		}
		this.info = info;
		this.initialized = true;
		try {
			await this.post(makeNotification("notifications/initialized"));
		} catch {}
		return info;
	}
	async request(method, params) {
		await this.initialize();
		try {
			return await this.post(makeRequest(method, params));
		} catch (e) {
			if (e instanceof McpTransportError && e.code === "http-404") {
				this.initialized = false;
				await this.initialize();
				return await this.post(makeRequest(method, params));
			}
			throw e;
		}
	}
	/** v1 keeps no persistent resources; the seam exists for SessionLike parity. */
	close() {}
	async post(message) {
		const headers = { ...this.headers };
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		let res;
		try {
			res = await this.fetchImpl(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (e) {
			throw describeFetchFailure(e);
		}
		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;
		if (!res.ok) throw new McpTransportError(`http-${res.status}`, `server answered HTTP ${res.status}`);
		const body = parseResponseBody(await res.text(), res.headers.get("content-type") ?? "");
		if (body === void 0 || body === null || body === "") return void 0;
		if (!isRpcResponse(body)) throw new McpTransportError("bad-json", "response is not a JSON-RPC response");
		if (body.error) throw new McpTransportError("rpc-error", rpcErrorMessage(body.error));
		return body.result;
	}
};

//#endregion
//#region src/client/stdio-client.ts
function win32PathDirs(env) {
	const pathKey = Object.keys(env ?? {}).find((key) => key.toLowerCase() === "path");
	return (pathKey ? String(env[pathKey] ?? "") : "").split(";").map((entry) => entry.trim()).filter(Boolean);
}
function win32PathExts(env) {
	const key = Object.keys(env ?? {}).find((item) => item.toLowerCase() === "pathext");
	const values = (key ? String(env[key] ?? "") : ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim()).filter(Boolean);
	return values.length ? values : [
		".COM",
		".EXE",
		".BAT",
		".CMD"
	];
}
function win32Comspec(env) {
	const key = Object.keys(env ?? {}).find((item) => item.toLowerCase() === "comspec");
	return key && env[key] ? String(env[key]) : "cmd.exe";
}
function isBareWin32Command(command) {
	const raw = command.trim();
	return !!raw && !/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw);
}
function isWin32CmdShim(command) {
	return /\.(?:cmd|bat)$/i.test(command);
}
function isWin32Executable(command) {
	return /\.exe$/i.test(command);
}
/** Quote one argument for a cmd.exe /c command line. */
function quoteWin32CmdArg(value) {
	const text = String(value ?? "");
	if (text.length === 0) return "\"\"";
	if (!/[\s"&|<>^()%]/.test(text)) return text;
	return `"${text.replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}
/** The ONLY place command + args are ever joined, and always space-separated. */
function buildWin32CmdLine(command, args) {
	return [command, ...args].map(quoteWin32CmdArg).join(" ");
}
function resolveWin32PathCommand(raw, env, existsSync) {
	if (!raw) return "";
	const hasPath = /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw);
	const dot = raw.lastIndexOf(".");
	const ext = dot > raw.lastIndexOf("/") && dot > raw.lastIndexOf("\\") ? raw.slice(dot) : "";
	const pathext = win32PathExts(env);
	const candidates = ext ? [raw] : [raw, ...pathext.map((suffix) => `${raw}${suffix}`)];
	if (hasPath) return candidates.find((candidate) => existsSync(candidate)) ?? "";
	for (const dir of win32PathDirs(env)) for (const candidate of candidates) {
		const full = `${dir}\\${candidate}`;
		if (existsSync(full)) return full;
	}
	return "";
}
function resolveWin32Command(command, env, existsSync) {
	const effective = resolveWin32PathCommand(command, env, existsSync) || command;
	if (isWin32CmdShim(effective)) return {
		command: effective,
		needsCmd: true
	};
	if (isWin32Executable(effective)) return {
		command: effective,
		needsCmd: false
	};
	if (isBareWin32Command(command)) return {
		command: effective,
		needsCmd: true
	};
	return {
		command: effective,
		needsCmd: false
	};
}
/** Build the final spawn(command, args) pair for the current platform. */
function resolveStdioSpawnSpec(record, opts) {
	const command = String(record.command || "").trim();
	const args = [...record.args];
	const env = {
		...opts.baseEnv ?? process.env,
		...record.env
	};
	if (opts.platform !== "win32") return {
		command,
		args,
		env
	};
	const resolved = resolveWin32Command(command, env, opts.existsSync ?? (() => false));
	if (!resolved.needsCmd) return {
		command: resolved.command,
		args,
		env
	};
	return {
		command: win32Comspec(env),
		args: [
			"/d",
			"/s",
			"/c",
			buildWin32CmdLine(resolved.command, args)
		],
		env
	};
}
const STDERR_TAIL_BYTES = 8 * 1024;
var McpStdioSession = class {
	record;
	opts;
	process = null;
	buffer = "";
	stderrTail = "";
	pending = /* @__PURE__ */ new Map();
	exited = null;
	info = {};
	constructor(record, opts = {}) {
		this.record = record;
		this.opts = opts;
	}
	ensureStarted() {
		if (this.process) return this.process;
		const spec = resolveStdioSpawnSpec({
			command: this.record.command,
			args: this.record.args,
			cwd: this.opts.cwd,
			env: this.opts.env
		}, {
			platform: this.opts.platform ?? process.platform,
			baseEnv: this.opts.baseEnv,
			existsSync: this.opts.existsSync
		});
		const child = (this.opts.spawnFn ?? spawn)(spec.command, spec.args, {
			cwd: this.opts.cwd || void 0,
			env: spec.env,
			shell: false,
			windowsHide: true
		});
		child.stdout.on("data", (chunk) => this.onData(chunk));
		child.stderr.on("data", (chunk) => this.onStderr(chunk));
		child.on("exit", (code, signal) => this.onExit(code, signal));
		this.process = child;
		return child;
	}
	onData(chunk) {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.dispatch(line);
			newline = this.buffer.indexOf("\n");
		}
	}
	dispatch(line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRpcResponse(msg)) return;
		if (typeof msg.id !== "number") return;
		const entry = this.pending.get(msg.id);
		if (!entry) return;
		this.pending.delete(msg.id);
		clearTimeout(entry.timer);
		if (msg.error) entry.reject(new McpTransportError("rpc-error", rpcErrorMessage(msg.error)));
		else entry.resolve(msg.result);
	}
	onStderr(chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
	}
	onExit(code, signal) {
		this.exited = `process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
		this.process = null;
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			const tail = this.stderrTail.trim().slice(-400);
			entry.reject(new McpTransportError("process-exited", `${this.exited}${tail ? `; stderr: ${tail}` : ""}`));
			this.pending.delete(id);
		}
	}
	async initialize(timeoutMs) {
		const result = await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: {
				name: "dsh-mcp-registry",
				version: "0.1.0"
			}
		}, timeoutMs);
		if (result && typeof result === "object") {
			const obj = result;
			if (typeof obj.protocolVersion === "string") this.info.protocolVersion = obj.protocolVersion;
			const si = obj.serverInfo;
			if (si && typeof si === "object") {
				const serverInfo = si;
				if (typeof serverInfo.name === "string") this.info.serverName = serverInfo.name;
				if (typeof serverInfo.version === "string") this.info.serverVersion = serverInfo.version;
			}
		}
		this.sendNotification(makeNotification("notifications/initialized"));
	}
	async request(method, params, timeoutMs = 6e4) {
		const child = this.ensureStarted();
		if (this.exited) throw new McpTransportError("process-exited", this.exited);
		const req = makeRequest(method, params);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(req.id);
				reject(new McpTransportError("timeout", `${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(req.id, {
				resolve,
				reject,
				timer
			});
			try {
				child.stdin.write(JSON.stringify(req) + "\n");
			} catch (e) {
				clearTimeout(timer);
				this.pending.delete(req.id);
				reject(new McpTransportError("stdin-failed", `failed to write to child stdin: ${e.message}`));
			}
		});
	}
	sendNotification(note) {
		const child = this.ensureStarted();
		try {
			child.stdin.write(JSON.stringify(note) + "\n");
		} catch {}
	}
	stderrTailForDiagnostics() {
		return this.stderrTail.trim().slice(-400);
	}
	close() {
		for (const [, entry] of this.pending) clearTimeout(entry.timer);
		this.pending.clear();
		if (this.process) {
			try {
				this.process.kill();
			} catch {}
			this.process = null;
		}
	}
};

//#endregion
//#region src/bridge.ts
const CALL_TIMEOUT_MS = 6e4;
function defaultSessionFactory(record) {
	if (record.transport === "streamable-http") return new McpHttpSession(record.url, {
		headers: record.headers,
		authToken: record.authType === "bearer" ? record.authToken : void 0,
		timeoutMs: 1e4
	});
	return new McpStdioSession({
		command: record.command,
		args: record.args
	}, {
		cwd: record.cwd,
		env: record.env
	});
}
var McpBridge = class {
	store;
	config;
	createSession;
	sessions = /* @__PURE__ */ new Map();
	evidence = /* @__PURE__ */ new Map();
	probeInFlight = /* @__PURE__ */ new Map();
	/** Last probe outcome per connector — display cache only, never persisted. */
	probeCache = /* @__PURE__ */ new Map();
	constructor(store, config, createSession = defaultSessionFactory) {
		this.store = store;
		this.config = config;
		this.createSession = createSession;
	}
	getSession(record) {
		let session = this.sessions.get(record.id);
		if (!session) {
			session = this.createSession(record);
			this.sessions.set(record.id, session);
		}
		return session;
	}
	requireConnector(id) {
		const record = this.store.get(id);
		if (!record) throw new McpTransportError("unknown-connector", `no connector "${id}" in the registry`);
		if (!record.enabled) throw new McpTransportError("connector-disabled", `connector "${id}" is disabled`);
		if (record.pendingConfirmation) throw new McpTransportError("pending-confirmation", `connector "${id}" was imported and still awaits human confirmation (mcp-reg confirm ${id})`);
		return record;
	}
	/** tools/list; refreshes the in-memory annotation evidence table. */
	async listTools(id) {
		const record = this.requireConnector(id);
		const tools = extractTools(await this.getSession(record).request("tools/list", {}, Math.max(this.config.getProbeTimeoutMs(), 1e4)));
		const entry = {
			listedAt: Date.now(),
			tools: /* @__PURE__ */ new Map()
		};
		for (const tool of tools) entry.tools.set(tool.name, tool.annotations ?? {});
		this.evidence.set(id, entry);
		return tools;
	}
	/**
	* One MCP initialize against a THROWAWAY session. Honest outcome either
	* way: ok=false carries a stable failure code, never a guessed "healthy".
	* Single-flight per connector so a double click does not double-spawn.
	*/
	probe(id) {
		const inFlight = this.probeInFlight.get(id);
		if (inFlight) return inFlight;
		const run = this.doProbe(id).then((outcome) => {
			this.probeCache.set(id, outcome);
			return outcome;
		}).finally(() => {
			this.probeInFlight.delete(id);
		});
		this.probeInFlight.set(id, run);
		return run;
	}
	async doProbe(id) {
		const record = this.requireConnector(id);
		const started = Date.now();
		let session = null;
		try {
			session = this.createSession(record);
			const info = await session.initialize(this.config.getProbeTimeoutMs());
			return {
				ok: true,
				latencyMs: Date.now() - started,
				at: Date.now(),
				protocolVersion: info?.protocolVersion,
				serverName: info?.serverName,
				serverVersion: info?.serverVersion
			};
		} catch (e) {
			const err = e instanceof McpTransportError ? e : new McpTransportError("probe-failed", e.message);
			return {
				ok: false,
				code: err.code,
				message: err.message,
				latencyMs: Date.now() - started,
				at: Date.now()
			};
		} finally {
			session?.close();
		}
	}
	async callTool(id, toolName, args, via, defaultMode) {
		const record = this.requireConnector(id);
		const annotations = this.evidence.get(id)?.tools.get(toolName);
		if (via === "agent") {
			if (resolveToolAccess({
				permissionMode: record.permissionMode ?? defaultMode,
				toolPermission: record.toolPermissions[toolName],
				trustReadOnlyHint: record.trustReadOnlyHint
			}, {
				listed: this.evidence.has(id),
				annotations
			}) === "review") return {
				ok: false,
				status: "needs_review",
				reason: reviewReason(record, toolName, annotations),
				hint: `The connector owner can run: mcp-reg mode ${record.id} allowlist && mcp-reg grant ${record.id} ${toolName} — or call it themselves via mcp-reg call.`
			};
		}
		return {
			ok: true,
			status: "executed",
			result: await this.getSession(record).request("tools/call", {
				name: toolName,
				arguments: args ?? {}
			}, CALL_TIMEOUT_MS)
		};
	}
	evidenceAgeMs(id) {
		const entry = this.evidence.get(id);
		return entry ? Date.now() - entry.listedAt : void 0;
	}
	closeAll() {
		for (const [, session] of this.sessions) session.close();
		this.sessions.clear();
		this.evidence.clear();
	}
};
function extractTools(result) {
	if (result === null || typeof result !== "object") return [];
	const tools = result.tools;
	if (!Array.isArray(tools)) return [];
	const out = [];
	for (const raw of tools) {
		if (raw === null || typeof raw !== "object") continue;
		const obj = raw;
		if (typeof obj.name !== "string" || !obj.name) continue;
		const annotationsObj = obj.annotations;
		const annotations = annotationsObj && typeof annotationsObj === "object" && !Array.isArray(annotationsObj) ? annotationsObj : void 0;
		out.push({
			name: obj.name,
			description: typeof obj.description === "string" ? obj.description : void 0,
			annotations: annotations ? mergeAnnotations(void 0, annotations) : void 0
		});
	}
	return out;
}
function reviewReason(record, toolName, annotations) {
	if (record.permissionMode !== "allowlist") return `connector "${record.id}" is in review-all mode: every agent call needs an explicit decision`;
	if (annotations?.destructiveHint === true) return `tool "${toolName}" is declared destructiveHint by its server — a known danger is never silently approved`;
	if (record.trustReadOnlyHint && annotations?.readOnlyHint !== true) return `tool "${toolName}" has no live read-only declaration from the running server, and implicit trust requires fresh evidence`;
	return `tool "${toolName}" has no explicit grant for connector "${record.id}"`;
}

//#endregion
//#region src/surface/tool.ts
const LOOSE_OBJECT_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: { ok: {
		type: "boolean",
		required: true
	} }
};
function renderAsJson(_args, value) {
	return [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}];
}
function createStatusTool(store, bridge) {
	return defineTool({
		name: "mcp_registry_status",
		description: "List the registered MCP connectors with their authorization policy and last probe result. Read-only diagnostics: targets are redacted (origin / command basename) and no credentials are included. Use it to check which connectors exist before calling mcp_bridge_call.",
		parameters: {},
		output: {
			schema: LOOSE_OBJECT_SCHEMA,
			render: renderAsJson
		},
		execute: async () => {
			if (store.isDamaged()) return {
				ok: false,
				damaged: true,
				reason: store.damageReason,
				corruptFile: store.corruptFilePath,
				note: "The registry file failed to load; every connector is treated as nonexistent until a human fixes it."
			};
			return {
				ok: true,
				connectors: store.list().map((record) => {
					const probe = bridge.probeCache.get(record.id);
					return {
						...publicView(record),
						probe: probe ? {
							ok: probe.ok,
							at: probe.at,
							latencyMs: probe.latencyMs,
							...probe.ok ? {
								serverName: probe.serverName,
								protocolVersion: probe.protocolVersion
							} : {
								code: probe.code,
								message: probe.message
							}
						} : {
							ok: null,
							note: "never probed in this session"
						}
					};
				})
			};
		}
	});
}
function createListToolsTool(bridge) {
	return defineTool({
		name: "mcp_bridge_list_tools",
		description: "List the tools a registered MCP connector currently exposes (runs tools/list against it). Read-only.",
		parameters: { connector: {
			type: "string",
			description: "Connector id from mcp_registry_status.",
			required: true
		} },
		output: {
			schema: LOOSE_OBJECT_SCHEMA,
			render: renderAsJson
		},
		execute: async (args) => {
			const tools = await bridge.listTools(args.connector);
			return {
				ok: true,
				connector: args.connector,
				tools: tools.map((t) => ({
					name: t.name,
					description: t.description,
					annotations: t.annotations ?? {}
				}))
			};
		}
	});
}
function createBridgeTool(bridge, getDefaultMode) {
	return defineTool({
		name: "mcp_bridge_call",
		description: "Call a tool on a registered MCP connector. The connector policy decides silently-allowed vs needs_review: a needs_review answer means the human must grant the tool (mcp-reg grant) or call it themselves (mcp-reg call). Use mcp_registry_status to discover connector ids and mcp_bridge_list_tools to discover tool names.",
		parameters: {
			connector: {
				type: "string",
				description: "Connector id from mcp_registry_status.",
				required: true
			},
			tool: {
				type: "string",
				description: "Tool name as exposed by that connector.",
				required: true
			},
			arguments: {
				type: "object",
				additionalProperties: true,
				description: "Tool arguments object (validated by the remote server)."
			}
		},
		output: {
			schema: LOOSE_OBJECT_SCHEMA,
			render: renderAsJson
		},
		timeoutMs: 7e4,
		execute: async (args) => {
			const outcome = await bridge.callTool(args.connector, args.tool, args.arguments ?? {}, "agent", getDefaultMode());
			if (outcome.status === "needs_review") return {
				ok: false,
				status: outcome.status,
				reason: outcome.reason,
				hint: outcome.hint
			};
			return {
				ok: outcome.ok,
				status: outcome.status,
				result: outcome.result
			};
		}
	});
}

//#endregion
//#region src/io/import.ts
var McpImportError = class extends Error {
	connectorId;
	code;
	constructor(connectorId, code, message) {
		super(message);
		this.connectorId = connectorId;
		this.code = code;
	}
};
function importMcpJson(text, opts) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new McpImportError("*", "invalid-json", `input is not valid JSON: ${e.message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new McpImportError("*", "not-an-object", "MCP JSON must be an object like {\"mcpServers\": {\"<id>\": {...}}}");
	const servers = parsed.mcpServers;
	if (servers === void 0 || servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new McpImportError("*", "missing-mcpServers", "MCP JSON must contain a \"mcpServers\" object");
	if (hasUnsafeKeyDeep(servers)) throw new McpImportError("*", "proto-pollution", "input contains __proto__/constructor/prototype keys — rejected entirely");
	const entries = Object.entries(servers);
	if (entries.length === 0) throw new McpImportError("*", "empty", "mcpServers is empty — nothing to import");
	return { records: entries.map(([id, raw]) => normalizeConnectorInput(id, raw, {
		provenance: opts.provenance ?? "import",
		now: opts.now
	})) };
}

//#endregion
//#region src/io/export.ts
function exportMcpJson(records, opts = {}) {
	const includeSecrets = opts.includeSecrets === true;
	const servers = {};
	for (const record of records) if (record.transport === "stdio") {
		const entry = {
			command: record.command,
			args: [...record.args]
		};
		if (record.cwd) entry.cwd = record.cwd;
		if (Object.keys(record.env).length > 0) entry.env = maskValues(record.env, includeSecrets);
		servers[record.id] = entry;
	} else {
		const entry = {
			url: record.url,
			transport: "streamable-http"
		};
		if (record.authType === "bearer") {
			const headers = { ...record.headers };
			let sawAuthHeader = false;
			for (const k of Object.keys(headers)) if (k.toLowerCase() === "authorization") {
				sawAuthHeader = true;
				headers[k] = includeSecrets ? headers[k] ?? MASK : `Bearer ${MASK}`;
			}
			if (!sawAuthHeader) headers["authorization"] = includeSecrets ? `Bearer ${record.authToken}` : `Bearer ${MASK}`;
			entry.headers = headers;
		} else if (Object.keys(record.headers).length > 0) entry.headers = maskValues(record.headers, includeSecrets);
		servers[record.id] = entry;
	}
	return JSON.stringify({ mcpServers: servers }, null, 2);
}
function maskValues(record, includeSecrets) {
	const out = {};
	for (const [key, value] of Object.entries(record)) out[key] = includeSecrets ? value : value ? MASK : value;
	return out;
}

//#endregion
//#region src/surface/command.ts
const HELP = `mcp-reg — MCP connector registry console

  mcp-reg list                       list connectors (redacted)
  mcp-reg probe <id>                 run one MCP initialize handshake
  mcp-reg import <path|json>         import mcpServers JSON (lands disabled + unconfirmed)
  mcp-reg export [--secrets]         export mcpServers JSON (secrets masked unless --secrets)
  mcp-reg confirm <id>               confirm an imported connector and enable it
  mcp-reg enable|disable <id>        flip the enabled switch
  mcp-reg mode <id> <review-all|allowlist>   set the permission mode
  mcp-reg grant <id> <tool|*>        allow a tool (or all) for agent calls
  mcp-reg revoke <id> <tool|*>       drop tool grants (back to review)
  mcp-reg trust <id> <on|off>        trust the server's readOnlyHint for ungranted tools
  mcp-reg call <id> <tool> [json]    call a tool as the USER (counts as approval)
  mcp-reg help                       this text`;
function registerMcpRegCommand(ctx, deps) {
	if (typeof ctx.commands?.register !== "function") return void 0;
	return ctx.commands.register({
		name: "mcp-reg",
		description: "MCP connector registry console: list/probe/import/export connectors, set permission mode, grant tools, and call tools as the user. Run `mcp-reg help` for subcommands.",
		input: { hint: "<list|probe|import|export|confirm|enable|disable|mode|grant|revoke|trust|call|help> ..." },
		handler: (invocation) => {
			const text = String(invocation?.rawInput ?? "").trim();
			let outcome;
			try {
				outcome = dispatch(text, deps);
			} catch (e) {
				return {
					kind: "error",
					text: `mcp-reg failed: ${errorMessage(e)}`
				};
			}
			if (!(outcome instanceof Promise)) return {
				kind: "text",
				text: outcome
			};
			return outcome.then((text$1) => ({
				kind: "text",
				text: text$1
			}), (e) => ({
				kind: "error",
				text: `mcp-reg failed: ${errorMessage(e)}`
			}));
		}
	});
}
function errorMessage(e) {
	if (e instanceof McpImportError) return `import[${e.connectorId}] ${e.code}: ${e.message}`;
	if (e instanceof UnknownConnectorError) return e.message;
	return e.message;
}
function dispatch(input, deps) {
	const parts = input.split(/\s+/).filter(Boolean);
	const sub = parts[0] ?? "help";
	const rest = parts.slice(1);
	const { store, bridge } = deps;
	switch (sub) {
		case "help": return HELP;
		case "list": {
			if (store.isDamaged()) return damageNotice(store);
			const connectors = store.list();
			if (connectors.length === 0) return "registry is empty — import with: mcp-reg import <path|json>";
			return connectors.map((c) => {
				const view = publicView(c);
				const probe = bridge.probeCache.get(c.id);
				const probeText = probe ? probe.ok ? `alive (${probe.latencyMs}ms)` : `down (${probe.code})` : "unprobed";
				const grants = view.grantedTools.length ? view.grantedTools.join(",") : "none";
				return `${c.enabled ? "on " : "off"} ${c.id}  [${c.transport}] ${view.target}  mode=${c.permissionMode}  grants=${grants}${c.pendingConfirmation ? "  UNCONFIRMED" : ""}  probe=${probeText}`;
			}).join("\n");
		}
		case "probe": {
			const id = rest[0] ?? "";
			if (!id) return "usage: mcp-reg probe <id>";
			return bridge.probe(id).then((outcome) => {
				if (outcome.ok) return `alive in ${outcome.latencyMs}ms — ${outcome.serverName ?? "unknown server"} ${outcome.serverVersion ?? ""} (protocol ${outcome.protocolVersion ?? "?"})`;
				return `probe failed: ${outcome.code} — ${outcome.message}`;
			});
		}
		case "import": {
			const source = rest.join(" ");
			if (!source) return "usage: mcp-reg import <path|inline json>";
			const { records } = importMcpJson(readImportSource(source), { now: Date.now() });
			for (const record of records) store.upsert(record);
			return `imported ${records.length} connector(s), all disabled + unconfirmed. Review, probe, then: mcp-reg confirm <id>\n` + records.map((r) => `  - ${r.id} [${r.transport}] ${redactTarget(r)}`).join("\n");
		}
		case "export": {
			const includeSecrets = rest.includes("--secrets");
			return exportMcpJson(store.list(), { includeSecrets });
		}
		case "confirm": return withRecord(store, rest[0], (record) => {
			store.confirm(record.id);
			return `confirmed "${record.id}" — enabled`;
		});
		case "enable":
		case "disable": return withRecord(store, rest[0], (record) => {
			store.setEnabled(record.id, sub === "enable");
			return `${sub}d "${record.id}"`;
		});
		case "mode": {
			const id = rest[0] ?? "";
			const mode = rest[1] ?? "";
			if (!id || mode !== "review-all" && mode !== "allowlist") return "usage: mcp-reg mode <id> <review-all|allowlist>";
			return withRecord(store, id, (c) => {
				store.updatePolicy(c.id, { permissionMode: mode });
				return `mode of "${c.id}" set to ${mode}`;
			});
		}
		case "grant":
		case "revoke": {
			const id = rest[0] ?? "";
			const tool = rest[1] ?? "";
			if (!id || !tool) return `usage: mcp-reg ${sub} <id> <tool|*>`;
			return withRecord(store, id, (c) => {
				const record = store.get(c.id);
				if (!record) return `no connector "${c.id}"`;
				const next = { ...record.toolPermissions };
				if (sub === "grant") next[tool] = "allow";
				else for (const key of Object.keys(next)) if (tool === "*" || key === tool) delete next[key];
				store.updatePolicy(c.id, { toolPermissions: next });
				if (sub === "grant") return `granted "${tool}" on "${c.id}" — agent calls to it are now policy-approved`;
				return `revoked on "${c.id}"${tool === "*" ? " (all grants cleared)" : ` ("${tool}" back to review)`}`;
			});
		}
		case "trust": {
			const id = rest[0] ?? "";
			const flag = rest[1] ?? "";
			if (!id || flag !== "on" && flag !== "off") return "usage: mcp-reg trust <id> <on|off>";
			return withRecord(store, id, (c) => {
				store.updatePolicy(c.id, { trustReadOnlyHint: flag === "on" });
				return `trustReadOnlyHint of "${c.id}" = ${flag}`;
			});
		}
		case "call": {
			const id = rest[0] ?? "";
			const tool = rest[1] ?? "";
			if (!id || !tool) return "usage: mcp-reg call <id> <tool> [json-arguments]";
			let args = {};
			const jsonPart = rest.slice(2).join(" ");
			if (jsonPart) try {
				args = JSON.parse(jsonPart);
			} catch (e) {
				return `arguments are not valid JSON: ${e.message}`;
			}
			return bridge.callTool(id, tool, args, "user", deps.getDefaultMode()).then((outcome) => JSON.stringify(outcome, null, 2));
		}
		default: return `unknown subcommand "${sub}"\n\n${HELP}`;
	}
}
function withRecord(store, id, fn) {
	if (!id) return "missing <id>";
	try {
		const record = store.get(id);
		if (!record) return `no connector "${id}" in the registry`;
		return fn(record);
	} catch (e) {
		if (e instanceof UnknownConnectorError) return `no connector "${id}" in the registry`;
		throw e;
	}
}
function damageNotice(store) {
	return `REGISTRY DAMAGED — fail-closed: every connector is treated as nonexistent.\nreason: ${store.damageReason}\ncorrupt file preserved at: ${store.corruptFilePath}\nFix or remove it, then restart. The registry refuses writes until then.`;
}
function readImportSource(source) {
	if (source.trimStart().startsWith("{")) return source;
	return readFileSync(source, "utf8");
}

//#endregion
//#region src/surface/http.ts
const API_PREFIX = "/mcp-registry/api";
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
function envelopeOk(value) {
	return {
		ok: true,
		value
	};
}
function envelopeError(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
async function readJsonBody(req, maxBytes = 262144) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) throw new Error("request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	return JSON.parse(text);
}
function registerMcpRegistryGateway(ctx, deps) {
	const webServer = ctx.get?.("webServer");
	if (!webServer || typeof webServer.register !== "function") return void 0;
	const { store, bridge } = deps;
	return webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (reqRaw, resRaw) => {
			const res = resRaw;
			const req = reqRaw;
			try {
				if (req.method !== "POST") {
					writeJson(res, 405, envelopeError("method-not-allowed", "POST only"));
					return;
				}
				const origin = req.headers.origin;
				if (origin) {
					let originHost;
					try {
						originHost = new URL(String(origin)).host;
					} catch {
						writeJson(res, 400, envelopeError("invalid-origin", "invalid Origin header"));
						return;
					}
					if (!req.headers.host || originHost !== String(req.headers.host)) {
						writeJson(res, 403, envelopeError("origin-not-allowed", "same-origin requests only"));
						return;
					}
				}
				if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, envelopeError("content-type-not-supported", "application/json required"));
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(`${API_PREFIX}/`.length) : "";
				if (method === "" || method.includes("/")) {
					writeJson(res, 404, envelopeError("not-found", "unknown mcp-registry API method"));
					return;
				}
				const body = await readJsonBody(req);
				const id = typeof body.id === "string" ? body.id : "";
				if (method === "status") {
					if (store.isDamaged()) {
						writeJson(res, 200, envelopeOk({
							enabled: deps.getEnabled(),
							damaged: true,
							damageReason: store.damageReason,
							corruptFile: store.corruptFilePath,
							connectors: []
						}));
						return;
					}
					writeJson(res, 200, envelopeOk({
						enabled: deps.getEnabled(),
						connectors: store.list().map((c) => ({
							...publicView(c),
							probe: bridge.probeCache.get(c.id) ?? null
						}))
					}));
					return;
				}
				if (method === "probe") {
					if (!id) {
						writeJson(res, 400, envelopeError("invalid-id", "id is required"));
						return;
					}
					writeJson(res, 200, envelopeOk({ outcome: await bridge.probe(id) }));
					return;
				}
				if (method === "confirm" || method === "enable" || method === "disable") {
					if (!id) {
						writeJson(res, 400, envelopeError("invalid-id", "id is required"));
						return;
					}
					writeJson(res, 200, envelopeOk({ connector: publicView(method === "confirm" ? store.confirm(id) : store.setEnabled(id, method === "enable")) }));
					return;
				}
				if (method === "policy") {
					if (!id) {
						writeJson(res, 400, envelopeError("invalid-id", "id is required"));
						return;
					}
					const patch = {};
					if (body.permissionMode === "review-all" || body.permissionMode === "allowlist") patch.permissionMode = body.permissionMode;
					if (typeof body.trustReadOnlyHint === "boolean") patch.trustReadOnlyHint = body.trustReadOnlyHint;
					if (typeof body.grant === "string" && body.grant.trim()) {
						const next = { ...store.get(id)?.toolPermissions ?? {} };
						next[body.grant.trim()] = "allow";
						patch.toolPermissions = next;
					}
					if (typeof body.revoke === "string" && body.revoke.trim()) {
						const next = { ...store.get(id)?.toolPermissions ?? {} };
						const target = body.revoke.trim();
						for (const key of Object.keys(next)) if (key === target || target === "*") delete next[key];
						patch.toolPermissions = next;
					}
					writeJson(res, 200, envelopeOk({ connector: publicView(store.updatePolicy(id, patch)) }));
					return;
				}
				if (method === "import") {
					const json = typeof body.json === "string" ? body.json : "";
					if (!json.trim()) {
						writeJson(res, 400, envelopeError("empty-json", "json is required"));
						return;
					}
					const { records } = importMcpJson(json, { now: Date.now() });
					for (const record of records) store.upsert(record);
					writeJson(res, 200, envelopeOk({ imported: records.map((r) => ({
						id: r.id,
						transport: r.transport,
						target: redactTarget(r)
					})) }));
					return;
				}
				if (method === "export") {
					writeJson(res, 200, envelopeOk({ json: exportMcpJson(store.list(), { includeSecrets: false }) }));
					return;
				}
				if (method === "call") {
					const tool = typeof body.tool === "string" ? body.tool : "";
					if (!id || !tool) {
						writeJson(res, 400, envelopeError("invalid-args", "id and tool are required"));
						return;
					}
					const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
					writeJson(res, 200, envelopeOk({ outcome: await bridge.callTool(id, tool, args, "user", "review-all") }));
					return;
				}
				writeJson(res, 404, envelopeError("not-found", `unknown mcp-registry API method "${method}"`));
			} catch (error) {
				if (error instanceof McpImportError) {
					writeJson(res, 400, envelopeError(`import-${error.code}`, `[${error.connectorId}] ${error.message}`));
					return;
				}
				if (error instanceof UnknownConnectorError) {
					writeJson(res, 404, envelopeError("unknown-connector", error.message));
					return;
				}
				if (error instanceof DamagedRegistryError) {
					writeJson(res, 409, envelopeError("registry-damaged", error.message));
					return;
				}
				if (error instanceof McpRecordError) {
					writeJson(res, 400, envelopeError(error.code, error.message));
					return;
				}
				const e = error;
				const message = error instanceof Error ? error.message : String(error);
				writeJson(res, 500, envelopeError(e?.code || "internal", message));
			}
		}
	});
}

//#endregion
//#region src/index.ts
const name = "dsh-mcp-registry";
const inject = ["tools", "commands"];
const Config = Config$1;
function resolveConfig(config) {
	return {
		enabled: config.enabled !== false,
		defaultPermissionMode: normalizePermissionMode(config.defaultPermissionMode),
		probeTimeoutMs: clampNumber(config.probeTimeoutMs, 200, 3e4, 3e3)
	};
}
function clampNumber(value, min, max, fallback) {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}
function apply(ctx, config = {}) {
	const rootDir = join(homedir(), ".dsh", "mcp-registry");
	const store = new RegistryStore(realStoreIo(), { dir: rootDir });
	store.load();
	const cfg = {
		get enabled() {
			return resolveConfig(config).enabled;
		},
		get defaultPermissionMode() {
			return resolveConfig(config).defaultPermissionMode;
		},
		get probeTimeoutMs() {
			return resolveConfig(config).probeTimeoutMs;
		}
	};
	const bridge = new McpBridge(store, { getProbeTimeoutMs: () => cfg.probeTimeoutMs });
	ctx.effect?.(() => bridge.closeAll());
	const registerTool = (tool) => {
		const dispose = ctx.tools.register(tool);
		ctx.effect?.(() => dispose);
	};
	registerTool(createStatusTool(store, bridge));
	registerTool(createListToolsTool(bridge));
	registerTool(createBridgeTool(bridge, () => cfg.defaultPermissionMode));
	const commandDispose = registerMcpRegCommand(ctx, {
		store,
		bridge,
		getDefaultMode: () => cfg.defaultPermissionMode
	});
	if (commandDispose !== void 0) ctx.effect?.(() => commandDispose);
	if (typeof ctx.provide === "function") {
		const disposeProvide = ctx.provide("dsh-mcp-registry", {
			status() {
				if (store.isDamaged()) return {
					damaged: true,
					reason: store.damageReason
				};
				return {
					enabled: cfg.enabled,
					connectors: store.list().map((c) => publicView(c))
				};
			},
			listAuthorized(consumerId) {
				if (!cfg.enabled || store.isDamaged()) return [];
				return store.list().filter((c) => c.enabled && !c.pendingConfirmation && c.permissionMode === "allowlist").map((c) => publicView(c));
			}
		});
		if (typeof disposeProvide === "function") ctx.effect?.(() => disposeProvide);
	}
	const dynamicInject = ctx.inject;
	const gatewayDeps = {
		store,
		bridge,
		getEnabled: () => cfg.enabled
	};
	if (typeof dynamicInject === "function") dynamicInject.call(ctx, ["webServer"], (sctx) => {
		const gatewayDispose = registerMcpRegistryGateway(sctx, gatewayDeps);
		if (typeof gatewayDispose === "function") ctx.effect?.(() => gatewayDispose);
	});
	else {
		const gatewayDispose = registerMcpRegistryGateway(ctx, gatewayDeps);
		if (typeof gatewayDispose === "function") ctx.effect?.(() => gatewayDispose);
	}
}
/**
* Real filesystem IO, isolated here so everything else (and every test) runs
* against the injected StoreFileIo interface instead of node:fs.
*/
function realStoreIo() {
	return {
		readFile: (path) => {
			try {
				return fs.readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		writeFile: (path, data) => fs.writeFileSync(path, data, "utf8"),
		rename: (src, dst) => fs.renameSync(src, dst),
		rmIfExists: (path) => {
			try {
				fs.rmSync(path, { force: true });
			} catch {}
		},
		mkdirp: (path) => fs.mkdirSync(path, { recursive: true }),
		listDir: (path) => {
			try {
				return fs.readdirSync(path);
			} catch {
				return [];
			}
		},
		rm: (path) => fs.rmSync(path, { force: true }),
		exists: (path) => fs.existsSync(path)
	};
}

//#endregion
export { Config, apply, inject, name, resolveConfig };