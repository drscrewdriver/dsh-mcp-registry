window.__ModuleLoader__.load({ id: "dsh-mcp-registry", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

//#region src/client/index.ts
const React = require("react");
const ID = "dsh-mcp-registry";
const API = "/mcp-registry/api";
const DICT = {
	famTitle: {
		zh: "MCP 注册表",
		en: "MCP Registry"
	},
	cfgUnavailable: {
		zh: "配置字段此宿主线不可读（configForms 缺席，老线常态）——连接器管理不受影响；配置可经 cordis.patch.yml 本条目 config 修改。",
		en: "Config fields unreadable on this host line (no configForms) — connector management is unaffected; edit this entry's config in cordis.patch.yml."
	},
	familyTitle: {
		zh: "起子插件设置",
		en: "Plugin Family Settings"
	},
	gCore: {
		zh: "注册表与授权",
		en: "Registry & authorization"
	},
	enabled: {
		zh: "总开关",
		en: "Master switch"
	},
	enabledDesc: {
		zh: "关闭后 mcp_bridge_call 拒绝调用、状态工具报告禁用（注册表数据不受影响）。",
		en: "Off = mcp_bridge_call refuses and the status tool reports disabled (registry data is untouched)."
	},
	defaultPermissionMode: {
		zh: "默认授权模式",
		en: "Default permission mode"
	},
	defaultPermissionModeDesc: {
		zh: "review-all（安全默认）：agent 调用一律返回 needs_review，直到你显式放行；allowlist：仅显式放行的工具静默执行。",
		en: "review-all (safe default): agent calls return needs_review until granted; allowlist: only granted tools run silently."
	},
	probeTimeoutMs: {
		zh: "探活超时 (ms)",
		en: "Probe timeout (ms)"
	},
	probeTimeoutMsDesc: {
		zh: "一次 MCP initialize 握手的超时。",
		en: "Timeout for one MCP initialize handshake."
	},
	modeReviewAll: {
		zh: "全部审查",
		en: "Review all"
	},
	modeAllowlist: {
		zh: "白名单放行",
		en: "Allowlist"
	},
	gConnectors: {
		zh: "连接器",
		en: "Connectors"
	},
	refresh: {
		zh: "刷新",
		en: "Refresh"
	},
	importBtn: {
		zh: "导入",
		en: "Import"
	},
	importTitle: {
		zh: "导入 mcpServers JSON（导入后默认停用+待确认）",
		en: "Import mcpServers JSON (lands disabled + unconfirmed)"
	},
	importConfirm: {
		zh: "确认导入",
		en: "Import"
	},
	importCancel: {
		zh: "取消",
		en: "Cancel"
	},
	exportBtn: {
		zh: "导出（脱敏）",
		en: "Export (redacted)"
	},
	empty: {
		zh: "还没有连接器 — 粘贴 mcpServers JSON 导入，或在会话里运行 /mcp-reg。",
		en: "No connectors yet — paste mcpServers JSON to import, or run /mcp-reg in a session."
	},
	damaged: {
		zh: "注册表文件损坏（fail-closed）：",
		en: "Registry file damaged (fail-closed): "
	},
	probe: {
		zh: "探活",
		en: "Probe"
	},
	confirm: {
		zh: "确认",
		en: "Confirm"
	},
	enable: {
		zh: "启用",
		en: "Enable"
	},
	disable: {
		zh: "停用",
		en: "Disable"
	},
	grants: {
		zh: "放行",
		en: "grants"
	},
	grantPlaceholder: {
		zh: "输入工具名后回车=放行",
		en: "tool name + Enter = grant"
	},
	trust: {
		zh: "信任 readOnlyHint",
		en: "trust readOnlyHint"
	},
	alive: {
		zh: "存活",
		en: "alive"
	},
	down: {
		zh: "失败",
		en: "down"
	},
	unprobed: {
		zh: "未探活",
		en: "unprobed"
	},
	unconfirmed: {
		zh: "待确认",
		en: "unconfirmed"
	},
	working: {
		zh: "…",
		en: "…"
	}
};
function wt(key) {
	let lang = "en";
	try {
		lang = (navigator.language || "en").startsWith("zh") ? "zh" : "en";
	} catch {}
	const entry = DICT[key];
	return entry ? lang === "zh" ? entry.zh : entry.en : key;
}
const FIELD_GROUPS = [{
	gk: "gCore",
	fields: [
		{
			k: "enabled",
			kind: "bool",
			lk: "enabled",
			dk: "enabledDesc"
		},
		{
			k: "defaultPermissionMode",
			kind: "sel",
			lk: "defaultPermissionMode",
			dk: "defaultPermissionModeDesc",
			options: ["review-all", "allowlist"],
			optionLabels: {
				"review-all": "modeReviewAll",
				"allowlist": "modeAllowlist"
			}
		},
		{
			k: "probeTimeoutMs",
			kind: "num",
			min: 200,
			max: 3e4,
			step: 100,
			lk: "probeTimeoutMs",
			dk: "probeTimeoutMsDesc"
		}
	]
}];
/** Services required by the browser half (lesson from 0.2.3 — see header).
*  `configForms` must NOT be declared here: it is generation-exclusive
*  (0.1.7+) and a top-level declaration pends the whole client tree on
*  ≤0.1.5 hosts (0.2.10 tree-killer, M4 batch). Soft-read via configScope. */
const inject = ["slots"];
function configScope(ctx) {
	try {
		return typeof ctx.configForms?.get === "function" ? ctx.configForms.get(ID) : void 0;
	} catch {
		return;
	}
}
async function api(method, body) {
	const res = await fetch(`${API}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {})
	});
	const payload = await res.json().catch(() => null);
	if (!payload || typeof payload !== "object" || payload.ok !== true) {
		const message = payload && payload.error ? payload.error.message : `HTTP ${res.status}`;
		throw new Error(message);
	}
	return payload.value;
}
const BTN = {
	font: "inherit",
	fontSize: "12px",
	color: "inherit",
	cursor: "pointer",
	background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
	border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
	borderRadius: "8px",
	padding: "3px 10px"
};
const INPUT = {
	font: "inherit",
	color: "inherit",
	fontSize: "12px",
	background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
	border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
	borderRadius: "8px",
	padding: "3px 8px"
};
const CHIP = {
	...BTN,
	cursor: "default",
	padding: "1px 8px",
	borderRadius: "999px",
	marginRight: "4px"
};
const MONO = {
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	fontSize: "12px"
};
function GroupBlock(props) {
	const h = React.createElement;
	return h("div", { style: {
		borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
		paddingTop: "6px"
	} }, h("div", { style: {
		fontSize: "12px",
		fontWeight: 600,
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.9))",
		padding: "2px 0 4px"
	} }, wt(props.group.gk)), props.group.fields.map(function(f) {
		return h(FieldRow, {
			key: f.k,
			f,
			value: props.value,
			writable: props.writable,
			scope: props.scope
		});
	}));
}
function FieldRow(props) {
	const f = props.f;
	const value = props.value;
	const writable = props.writable;
	const scope = props.scope;
	const h = React.createElement;
	const rowStyle = {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: "12px",
		padding: "6px 0"
	};
	const label = h("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: "2px",
		minWidth: 0
	} }, h("span", { style: {
		fontSize: "13px",
		color: "var(--dsw-alias-label-primary, inherit)"
	} }, wt(f.lk)), f.dk ? h("span", { style: {
		fontSize: "12px",
		color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))",
		lineHeight: 1.5
	} }, wt(f.dk)) : null);
	if (f.kind === "bool") return h("div", { style: rowStyle }, label, h("input", {
		type: "checkbox",
		checked: value[f.k] === true,
		disabled: !writable,
		onChange: function(e) {
			scope.set(f.k, e.target.checked);
		}
	}));
	if (f.kind === "sel") return h("div", { style: rowStyle }, label, h("select", {
		value: String(value[f.k] ?? f.options[0]),
		disabled: !writable,
		style: INPUT,
		onChange: function(e) {
			scope.set(f.k, e.target.value);
		}
	}, f.options.map(function(o) {
		const labelKey = f.optionLabels?.[o];
		return h("option", {
			key: o,
			value: o
		}, labelKey ? wt(labelKey) : o);
	})));
	return h("div", { style: rowStyle }, label, h(NumInput, {
		f,
		v: value[f.k],
		writable,
		scope
	}));
}
function NumInput(props) {
	const f = props.f;
	const h = React.createElement;
	const draft = React.useState(props.v === void 0 || props.v === null ? "" : String(props.v));
	const v = draft[0];
	const setV = draft[1];
	React.useEffect(function() {
		setV(props.v === void 0 || props.v === null ? "" : String(props.v));
	}, [props.v]);
	return h("input", {
		type: "number",
		min: f.min,
		max: f.max,
		step: f.step,
		value: v,
		disabled: !props.writable,
		style: {
			...INPUT,
			width: "96px"
		},
		onChange: function(e) {
			setV(e.target.value);
		},
		onBlur: function() {
			if (v === "") return;
			let n = Number(v);
			if (!isFinite(n)) return;
			n = Math.round(n / (f.step || 1)) * (f.step || 1);
			if (f.min !== void 0) n = Math.max(f.min, n);
			if (f.max !== void 0) n = Math.min(f.max, n);
			props.scope.set(f.k, n);
		}
	});
}
function ConnectorManager() {
	const h = React.createElement;
	const [rows, setRows] = React.useState(null);
	const [damaged, setDamaged] = React.useState(null);
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState("");
	const [showImport, setShowImport] = React.useState(false);
	const [importText, setImportText] = React.useState("");
	const [exportText, setExportText] = React.useState("");
	const [notice, setNotice] = React.useState("");
	const refresh = React.useCallback(function() {
		api("status").then(function(value) {
			setDamaged(value.damaged ? `${value.damageReason ?? ""} — ${value.corruptFile ?? ""}` : null);
			setRows(value.connectors ?? []);
			setError("");
		}).catch(function(e) {
			setError(e.message);
		});
	}, []);
	React.useEffect(function() {
		refresh();
	}, [refresh]);
	const act = React.useCallback(function(method, body, key) {
		setBusy(key);
		api(method, body).then(function() {
			setError("");
			refresh();
		}).catch(function(e) {
			setError(e.message);
		}).finally(function() {
			setBusy("");
		});
	}, [refresh]);
	if (damaged) return h("div", { style: {
		padding: "8px 0",
		fontSize: "12px",
		color: "#e6a23c"
	} }, wt("damaged") + damaged);
	if (rows === null) return h("div", { style: {
		padding: "8px 0",
		fontSize: "12px",
		color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))"
	} }, "…");
	const toolbar = h("div", { style: {
		display: "flex",
		gap: "6px",
		padding: "4px 0"
	} }, h("button", {
		style: BTN,
		onClick: function() {
			refresh();
		}
	}, wt("refresh")), h("button", {
		style: BTN,
		onClick: function() {
			setShowImport(!showImport);
			setExportText("");
		}
	}, wt("importBtn")), h("button", {
		style: BTN,
		onClick: function() {
			api("export").then(function(v) {
				setExportText(v.json ?? "");
				setShowImport(false);
			}).catch(function(e) {
				setError(e.message);
			});
		}
	}, wt("exportBtn")));
	const importPanel = showImport ? h("div", { style: {
		display: "grid",
		gap: "6px",
		padding: "6px 0"
	} }, h("div", { style: {
		fontSize: "12px",
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.9))"
	} }, wt("importTitle")), h("textarea", {
		value: importText,
		placeholder: "{\"mcpServers\":{\"example\":{\"command\":\"npx\",\"args\":[\"-y\",\"mcp-server-example\"]}}}",
		style: {
			...MONO,
			minHeight: "90px",
			padding: "8px",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			borderRadius: "8px",
			color: "inherit"
		},
		onChange: function(e) {
			setImportText(e.target.value);
		}
	}), h("div", { style: {
		display: "flex",
		gap: "6px"
	} }, h("button", {
		style: BTN,
		onClick: function() {
			setBusy("import");
			api("import", { json: importText }).then(function(v) {
				setImportText("");
				setShowImport(false);
				setError("");
				setNotice(`${wt("importBtn")}: ${(v.imported ?? []).length}`);
				refresh();
			}).catch(function(e) {
				setError(e.message);
			}).finally(function() {
				setBusy("");
			});
		}
	}, wt("importConfirm") + (busy === "import" ? wt("working") : "")), h("button", {
		style: BTN,
		onClick: function() {
			setShowImport(false);
		}
	}, wt("importCancel")))) : null;
	const exportPanel = exportText !== "" ? h("textarea", {
		readOnly: true,
		value: exportText,
		style: {
			...MONO,
			minHeight: "90px",
			width: "100%",
			padding: "8px",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
			borderRadius: "8px",
			color: "inherit"
		}
	}) : null;
	const list = rows.length === 0 ? h("div", { style: {
		padding: "6px 0",
		fontSize: "12px",
		color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))"
	} }, wt("empty")) : rows.map(function(row) {
		return h(ConnectorCard, {
			key: row.id,
			row,
			act,
			busy
		});
	});
	return h("div", { style: {
		borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
		paddingTop: "6px"
	} }, h("div", { style: {
		fontSize: "12px",
		fontWeight: 600,
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.9))",
		padding: "2px 0 4px"
	} }, wt("gConnectors")), toolbar, importPanel, exportPanel, error !== "" ? h("div", { style: {
		fontSize: "12px",
		color: "#f56c6c",
		padding: "4px 0",
		whiteSpace: "pre-wrap"
	} }, error) : null, notice !== "" ? h("div", { style: {
		fontSize: "12px",
		color: "#67c23a",
		padding: "4px 0"
	} }, notice) : null, list);
}
function probeBadge(row) {
	if (!row.probe) return {
		text: wt("unprobed"),
		color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))"
	};
	return row.probe.ok ? {
		text: `${wt("alive")} ${row.probe.latencyMs ?? ""}ms`,
		color: "#67c23a"
	} : {
		text: `${wt("down")} ${row.probe.code ?? ""}`,
		color: "#f56c6c"
	};
}
function ConnectorCard(props) {
	const row = props.row;
	const act = props.act;
	const busy = props.busy;
	const h = React.createElement;
	const [grantText, setGrantText] = React.useState("");
	const badge = probeBadge(row);
	return h("div", { style: {
		borderBottom: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.2))",
		padding: "6px 0"
	} }, h("div", { style: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		flexWrap: "wrap"
	} }, h("span", { style: {
		...MONO,
		fontWeight: 600
	} }, row.id), h("span", { style: {
		...CHIP,
		fontSize: "11px"
	} }, row.transport), h("span", { style: MONO }, row.target), row.pendingConfirmation ? h("span", { style: {
		...CHIP,
		fontSize: "11px",
		color: "#e6a23c"
	} }, wt("unconfirmed")) : null, h("span", { style: {
		fontSize: "11px",
		color: badge.color
	} }, badge.text)), h("div", { style: {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		flexWrap: "wrap",
		padding: "3px 0"
	} }, h("select", {
		value: row.permissionMode,
		style: INPUT,
		onChange: function(e) {
			act("policy", {
				id: row.id,
				permissionMode: e.target.value
			}, row.id + ":mode");
		}
	}, h("option", { value: "review-all" }, wt("modeReviewAll")), h("option", { value: "allowlist" }, wt("modeAllowlist"))), h("label", { style: {
		display: "flex",
		alignItems: "center",
		gap: "4px",
		fontSize: "12px"
	} }, h("input", {
		type: "checkbox",
		checked: row.trustReadOnlyHint === true,
		title: wt("trust"),
		onChange: function() {
			act("policy", {
				id: row.id,
				trustReadOnlyHint: !(row.trustReadOnlyHint === true)
			}, row.id + ":trust");
		}
	}), wt("trust")), h("span", { style: {
		fontSize: "12px",
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.9))"
	} }, wt("grants") + ":"), row.grantedTools.length === 0 ? h("span", { style: {
		fontSize: "12px",
		color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.7))"
	} }, "—") : row.grantedTools.map(function(tool) {
		return h("span", {
			key: tool,
			style: {
				...CHIP,
				cursor: "pointer",
				fontSize: "11px"
			},
			title: wt("grants"),
			onClick: function() {
				act("policy", {
					id: row.id,
					revoke: tool
				}, row.id + ":revoke:" + tool);
			}
		}, tool + " ×");
	}), h("input", {
		value: grantText,
		placeholder: wt("grantPlaceholder"),
		style: {
			...INPUT,
			width: "160px"
		},
		onChange: function(e) {
			setGrantText(e.target.value);
		},
		onKeyDown: function(e) {
			if (e.key === "Enter" && grantText.trim() !== "") {
				act("policy", {
					id: row.id,
					grant: grantText.trim()
				}, row.id + ":grant");
				setGrantText("");
			}
		}
	})), h("div", { style: {
		display: "flex",
		gap: "6px",
		padding: "3px 0"
	} }, h("button", {
		style: BTN,
		onClick: function() {
			act("probe", { id: row.id }, row.id + ":probe");
		}
	}, wt("probe") + (busy === row.id + ":probe" ? wt("working") : "")), row.pendingConfirmation ? h("button", {
		style: BTN,
		onClick: function() {
			act("confirm", { id: row.id }, row.id + ":confirm");
		}
	}, wt("confirm")) : null, h("button", {
		style: BTN,
		onClick: function() {
			act(row.enabled ? "disable" : "enable", { id: row.id }, row.id + ":toggle");
		}
	}, row.enabled ? wt("disable") : wt("enable"))));
}
function SettingsCard(props) {
	const scope = props.scope;
	const h = React.createElement;
	if (!scope || typeof scope.getSnapshot !== "function") return h("div", { style: {
		padding: "8px 0",
		fontSize: "12px",
		color: "var(--dsh-alias-label-tertiary, rgba(127,127,127,.8))"
	} }, wt("cfgUnavailable"));
	const snapshot = React.useSyncExternalStore(function(listener) {
		return scope.subscribe(listener);
	}, function() {
		return scope.getSnapshot();
	});
	const value = snapshot.value || {};
	const writable = snapshot.writable === true;
	return h("div", { style: {
		display: "grid",
		gap: "8px"
	} }, FIELD_GROUPS.map(function(group) {
		return h(GroupBlock, {
			key: group.gk,
			group,
			value,
			writable,
			scope
		});
	}), h(ConnectorManager, { key: "connectors" }));
}
function apply(ctx) {
	if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
	ctx.slots.inject("dsh-family.tab", function() {
		return ctx.slots.register({
			name: "dsh-family.tab",
			id: ID,
			order: 40,
			label: function() {
				return wt("famTitle");
			},
			inject: function() {
				return { scope: configScope(ctx) };
			}
		}, SettingsCard);
	}, "dsh-mcp-registry: family settings tab");
	ctx.slots.inject("plugins.bundle.config", function() {
		return ctx.slots.register({
			name: "plugins.bundle.config",
			key: ID,
			inject: function() {
				return { scope: configScope(ctx) };
			}
		}, SettingsCard);
	}, "dsh-mcp-registry: plugins-page config card");
	const familyTabsHooks = makeFamilyTabsHooks(ctx.slots);
	ctx.effect?.(function() {
		let claimed;
		let done = false;
		const tryClaim = function() {
			if (done) return;
			let hosted;
			try {
				hosted = (typeof ctx.slots.entries === "function" ? ctx.slots.entries("settings.section") : []).some(function(e) {
					return e?.options?.id === FAMILY_SECTION_ID;
				});
			} catch {
				return;
			}
			if (hosted) return;
			try {
				claimed = ctx.slots.register({
					name: "settings.section",
					id: FAMILY_SECTION_ID,
					order: 40,
					label: function() {
						return wt("familyTitle");
					},
					inject: function() {
						return { hooks: { tabs: familyTabsHooks } };
					},
					children: { "dsh-family.tab": {
						kind: "list",
						scope: "root"
					} }
				}, FamilySection);
				done = true;
			} catch {
				done = true;
			}
		};
		const initial = setTimeout(tryClaim, FAMILY_HOST_GRACE_MS);
		const offChange = typeof ctx.slots.subscribe === "function" ? ctx.slots.subscribe("settings.section", function() {
			setTimeout(tryClaim, 300);
		}) : void 0;
		const interval = setInterval(tryClaim, 5e3);
		return function() {
			clearTimeout(initial);
			clearInterval(interval);
			if (typeof offChange === "function") offChange();
			if (typeof claimed === "function") claimed();
		};
	}, "dsh-mcp-registry: family fallback host");
}
/** 家族节固定 id（与 thinking-levels / guard / steward 严格一致）。 */
const FAMILY_SECTION_ID = "dsh-family";
/** 家族子席位 key（与 thinking-levels 的声明严格一致）。 */
const FAMILY_CHILD_KEY = "dsh-family.tab";
/** 接管宽限期：guard 2000ms、steward 2600ms 先试，本插件最后兜底。 */
const FAMILY_HOST_GRACE_MS = 3200;
/** 家族 tab 账本投影（照 dsh-session-steward 的 makeFamilyTabsHooks）。 */
function makeFamilyTabsHooks(slots) {
	let version = -1;
	let tabs = [];
	return {
		getSnapshot: function() {
			const next = slots.getVersion(FAMILY_CHILD_KEY);
			if (next !== version) {
				version = next;
				tabs = slots.entries(FAMILY_CHILD_KEY).map(function(entry) {
					const raw = entry?.options?.label;
					let label = String(entry?.options?.id ?? "");
					if (typeof raw === "function") try {
						label = String(raw() ?? label);
					} catch {}
					else if (typeof raw === "string") label = raw;
					return {
						id: entry?.options?.id ?? "",
						order: entry?.options?.order ?? 0,
						label
					};
				}).sort(function(a, b) {
					return a.order - b.order;
				});
			}
			return tabs;
		},
		subscribe: function(listener) {
			return slots.subscribe(FAMILY_CHILD_KEY, listener);
		}
	};
}
/**
* 家族节接管组件：纯通用渲染 —— 把 `dsh-family.tab` 账本里的每张贡献卡
* （含本插件自己的）按 order 依次 renderSlot。照 dsh-session-steward 的
* StewardFamilySection；renderSlot 由宿主设置壳经 section inject 传入。
*/
function FamilySection(props) {
	const h = React.createElement;
	try {
		const useTabs = props.useTabs;
		const renderSlot = typeof props.renderSlot === "function" ? props.renderSlot : null;
		const contributors = typeof useTabs === "function" ? useTabs(function(value) {
			return value;
		}) : [];
		const draft = React.useState(contributors[0]?.id ?? "");
		const activeId = draft[0];
		const setActiveId = draft[1];
		const effective = contributors.some(function(c) {
			return c.id === activeId;
		}) ? activeId : contributors[0]?.id ?? "";
		const tabBar = h("div", {
			role: "tablist",
			style: {
				display: "flex",
				flexWrap: "wrap",
				gap: "4px"
			}
		}, contributors.map(function(c) {
			const active = c.id === effective;
			return h("button", {
				key: c.id,
				type: "button",
				role: "tab",
				"aria-selected": active,
				style: {
					appearance: "none",
					font: "inherit",
					cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
					background: active ? "var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.08))" : "none",
					color: "var(--dsw-alias-label-primary, inherit)",
					borderRadius: "8px",
					padding: "5px 12px",
					fontSize: "13px"
				},
				onClick: function() {
					setActiveId(c.id);
				}
			}, c.label);
		}));
		const panel = renderSlot && effective !== "" ? h("div", {}, renderSlot("dsh-family.tab", {}, {
			only: effective,
			fallback: null
		})) : null;
		return h("div", { style: {
			display: "grid",
			gap: "10px"
		} }, contributors.length > 0 ? tabBar : null, panel);
	} catch (e) {
		return h("div", { style: {
			color: "#f56c6c",
			fontSize: "12px"
		} }, "family section error: " + e.message);
	}
}
const name = ID;

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.name = name;
return module.exports; } });
//# sourceMappingURL=client.js.map