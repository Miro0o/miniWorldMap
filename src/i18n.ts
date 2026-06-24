import type {
	ColorScheme,
	ExternalDetailMode,
	HoverHighlightMode,
	HoverTargetMode,
	LabelVisibility,
	Language,
	ViewMode,
} from './settings';

export const LANGUAGE_OPTIONS: [Language, string][] = [
	['en', 'English'],
	['zh', '中文'],
];

const STRINGS: Record<string, Record<Language, string>> = {
	'language': { en: 'Language', zh: '语言' },
	'language.en': { en: 'English', zh: 'English' },
	'language.zh': { en: 'Chinese', zh: '中文' },
	'mode.radial2d': { en: '2D', zh: '2D' },
	'mode.map3d': { en: '3D', zh: '3D' },
	'stats.counts': { en: '{nodes} nodes / {links} links', zh: '{nodes} 个节点 / {links} 条链接' },
	'stats.3d': {
		en: '{fps} fps · {calls} calls · {nodes}n/{links}l · {state}',
		zh: '{fps} fps · {calls} calls · {nodes} 节点/{links} 链接 · {state}',
	},
	'state.settled': { en: 'settled', zh: '已沉降' },
	'state.layout': { en: 'layout', zh: '布局中' },

	'tab.inspect': { en: 'Inspect', zh: '检查' },
	'tab.pins': { en: 'Pins', zh: '固定' },
	'tab.view': { en: 'View', zh: '视图' },
	'tab.controls': { en: 'Controls', zh: '控制' },
	'tab.defaults': { en: 'Defaults', zh: '默认' },
	'tab.appearance': { en: 'Appearance', zh: '外观' },
	'tab.physics': { en: 'Physics', zh: '力学' },
	'tab.motion': { en: 'Motion', zh: '运动' },
	'tab.advanced': { en: 'Advanced', zh: '高级' },

	'common.search': { en: 'Search', zh: '搜索' },
	'common.recenter': { en: 'Center', zh: '回中心' },
	'common.fit': { en: 'Fit', zh: '适配' },
	'common.rebuild': { en: 'Rebuild', zh: '重建' },
	'common.pin': { en: 'Pin', zh: '固定' },
	'common.pinCurrent': { en: 'Pin current', zh: '固定当前' },
	'common.clear': { en: 'Clear', zh: '清空' },
	'common.group': { en: 'Group', zh: '分组' },
	'common.ungroup': { en: 'Ungroup', zh: '取消分组' },
	'common.inspect': { en: 'Inspect', zh: '检查' },
	'common.open': { en: 'Open', zh: '打开' },
	'common.focus': { en: 'Focus', zh: '聚焦' },
	'common.root': { en: 'Root', zh: '根节点' },
	'common.source': { en: 'Source', zh: '来源' },
	'common.target': { en: 'Target', zh: '目标' },
	'common.none': { en: 'None', zh: '无' },
	'common.default': { en: 'Default', zh: '默认' },
	'common.resetDefaults': { en: 'Reset defaults', zh: '重置默认' },

	'view.atlas': { en: 'Atlas', zh: '图谱' },
	'view.focus': { en: 'Focus', zh: '聚焦' },
	'view.vaultRoot': { en: 'Vault root', zh: '库根目录' },
	'view.mode': { en: 'Map mode', zh: '地图模式' },
	'view.theme': { en: 'Theme', zh: '主题' },
	'theme.auto': { en: 'System', zh: '跟随系统' },
	'theme.radialAuto': { en: 'System', zh: '跟随系统' },
	'theme.day': { en: 'Light', zh: '浅色' },
	'theme.night': { en: 'Dark', zh: '深色' },
	'theme.deep': { en: 'Deep space', zh: '深空' },

	'inspect.type': { en: 'Type', zh: '类型' },
	'inspect.depth': { en: 'Depth', zh: '深度' },
	'inspect.notes': { en: 'Notes', zh: '笔记' },
	'inspect.out': { en: 'Out', zh: '出链' },
	'inspect.in': { en: 'In', zh: '入链' },
	'inspect.linkOverlay': { en: 'Note link', zh: '笔记链接' },
	'inspect.weight': { en: 'Weight', zh: '权重' },
	'inspect.raw': { en: 'Raw', zh: '原始' },
	'inspect.unresolved': { en: 'Unresolved', zh: '未解析' },
	'inspect.external': { en: 'Outside', zh: '外部' },
	'inspect.outgoing': { en: 'Outgoing ({count})', zh: '出链（{count}）' },
	'inspect.backlinks': { en: 'Backlinks ({count})', zh: '反向链接（{count}）' },
	'inspect.parentRoot': { en: 'Parent of root', zh: '当前根的父文件夹' },

	'pins.groupName': { en: 'Group name', zh: '分组名称' },
	'pins.empty': { en: 'No pinned paths.', zh: '暂无固定路径。' },
	'pins.already': { en: 'That path is already pinned.', zh: '这条路径已经固定。' },
	'pins.selectFirst': { en: 'Select pinned paths to group.', zh: '先选择要分组的固定路径。' },
	'pins.selectBeforePin': { en: 'Select or hover a path before pinning.', zh: '先选择或悬停一条路径再固定。' },
	'pins.ungrouped': { en: 'Ungrouped', zh: '未分组' },
	'pins.selectForGroup': { en: 'Select for grouping', zh: '选择用于分组' },
	'pins.hideHighlight': { en: 'Hide route', zh: '隐藏路线' },
	'pins.showHighlight': { en: 'Show route', zh: '显示路线' },

	'control.depth': { en: 'Depth', zh: '深度' },
	'control.nodes': { en: 'Nodes', zh: '节点' },
	'control.noteLinks': { en: 'Note links', zh: '笔记链接' },
	'control.showNoteLinks': { en: 'Show note links', zh: '显示笔记链接' },
	'control.hover': { en: 'Hover', zh: '悬停' },
	'control.hoverTargets': { en: 'Hover targets', zh: '悬停对象' },
	'control.labels': { en: 'Labels', zh: '标签' },
	'control.spin': { en: 'Ring spin', zh: '环形旋转' },
	'control.ringGuides': { en: 'Ring guides', zh: '环形参考线' },
	'control.outsideLinks': { en: 'Outside links', zh: '外部链接' },
	'control.outsideDetail': { en: 'Outside detail', zh: '外部细节' },
	'control.exactOutsideFiles': { en: 'Exact outside notes', zh: '精确外部笔记' },
	'control.legend': { en: 'Legend', zh: '图例' },
	'control.defaultDepth': { en: 'Default depth', zh: '默认深度' },
	'control.defaultNodes': { en: 'Default nodes', zh: '默认节点数' },
	'control.defaultNoteLinks': { en: 'Default note links', zh: '默认笔记链接' },
	'control.unresolvedLinks': { en: 'Unresolved links', zh: '未解析链接' },
	'control.ignoredFolders': { en: 'Ignored folders', zh: '忽略文件夹' },

	'hover.none': { en: 'None', zh: '无' },
	'hover.note-links': { en: 'Note links', zh: '笔记链接' },
	'hover.hierarchy-parents': { en: 'Parents', zh: '父级' },
	'hover.hierarchy-direct-children': { en: 'Direct children', zh: '直接子级' },
	'hover.hierarchy-descendants': { en: 'All children', zh: '全部子级' },
	'hover.hierarchy-parents-direct': { en: 'Parents + direct children', zh: '父级 + 直接子级' },
	'hover.hierarchy-all': { en: 'Parents + all children', zh: '父级 + 全部子级' },
	'hoverTarget.nodes': { en: 'Nodes only', zh: '仅节点' },
	'hoverTarget.links': { en: 'Links only', zh: '仅链接' },
	'hoverTarget.both': { en: 'Nodes + links', zh: '节点 + 链接' },
	'labels.auto': { en: 'Auto', zh: '自动' },
	'labels.hover': { en: 'Hover only', zh: '仅悬停' },
	'outside.grouped': { en: 'Groups', zh: '分组' },
	'outside.selected': { en: 'Selected', zh: '选中' },
	'outside.exact': { en: 'Exact', zh: '精确' },

	'legend.root': { en: 'Root', zh: '根节点' },
	'legend.root.desc': { en: 'Current atlas root', zh: '当前图谱根节点' },
	'legend.folder': { en: 'Folders', zh: '文件夹' },
	'legend.folder.desc': { en: 'Folders without a same-name child note', zh: '没有同名子笔记的文件夹' },
	'legend.folderMeta': { en: 'Folder notes', zh: '文件夹笔记' },
	'legend.folderMeta.desc': { en: 'Folder merged with its same-name child note', zh: '与同名子笔记合并的文件夹' },
	'legend.note': { en: 'Notes', zh: '笔记' },
	'legend.note.desc': { en: 'Markdown notes', zh: 'Markdown 笔记' },
	'legend.outsideGroup': { en: 'Outside groups', zh: '外部分组' },
	'legend.outsideGroup.desc': { en: 'Grouped branches outside the root', zh: '根节点外的分组分支' },
	'legend.outsideNote': { en: 'Outside notes', zh: '外部笔记' },
	'legend.outsideNote.desc': { en: 'Exact linked notes outside the root', zh: '根节点外的精确链接笔记' },
	'legend.unresolvedNote': { en: 'Unresolved notes', zh: '未解析笔记' },
	'legend.unresolvedNote.desc': { en: 'Unresolved internal link targets', zh: '未解析的内部链接目标' },
	'legend.hierarchy': { en: 'Hierarchy', zh: '层级' },
	'legend.hierarchy.desc': { en: 'Parent-child hierarchy edges', zh: '父子层级边' },
	'legend.noteLinks': { en: 'Note links', zh: '笔记链接' },
	'legend.noteLinks.desc': { en: 'Internal markdown links', zh: '内部 Markdown 链接' },
	'legend.outsideLinks': { en: 'Outside links', zh: '外部链接' },
	'legend.outsideLinks.desc': { en: 'Links crossing the current root', zh: '跨出当前根节点的链接' },
	'legend.unresolvedLinks': { en: 'Unresolved links', zh: '未解析链接' },
	'legend.unresolvedLinks.desc': { en: 'Links involving unresolved targets', zh: '包含未解析目标的链接' },

	'loading.radial': { en: 'Building map…', zh: '构建地图…' },
	'loading.3d': { en: 'Building map…', zh: '构建地图…' },
	'2d.searchPlaceholder': { en: 'Search notes or folders, press Enter to locate…', zh: '搜索笔记或文件夹，回车定位…' },
	'search.folder': { en: 'Folder', zh: '文件夹' },
	'search.note': { en: 'Note', zh: '笔记' },
	'search.external': { en: 'Outside', zh: '外部' },
	'search.notes': { en: '{count} notes', zh: '{count} 个笔记' },
	'context.openNote': { en: 'Open note', zh: '打开笔记' },
	'context.focusNote': { en: 'Focus note', zh: '聚焦笔记' },
	'context.useAsRoot': { en: 'Use as atlas root', zh: '设为图谱根节点' },
	'context.openRepresentative': { en: 'Open representative note', zh: '打开代表笔记' },
	'context.pinPath': { en: 'Pin highlighted path', zh: '固定高亮路径' },

	'3d.cruiseOn': { en: 'Cruise: on', zh: '巡航：开' },
	'3d.cruiseOff': { en: 'Cruise: off', zh: '巡航：关' },
	'3d.reveal': { en: 'Reveal', zh: '创世动画' },
	'3d.glow': { en: 'Glow', zh: '辉光' },
	'3d.glowStrength': { en: 'Strength', zh: '强度' },
	'3d.glowRadius': { en: 'Radius', zh: '扩散' },
	'3d.glowThreshold': { en: 'Threshold', zh: '阈值' },
	'3d.repel': { en: 'Repel', zh: '斥力' },
	'3d.linkDistance': { en: 'Link distance', zh: '链接距离' },
	'3d.linkStrength': { en: 'Link strength', zh: '链接强度' },
	'3d.centerPull': { en: 'Center pull', zh: '向心力' },
	'3d.flatten': { en: 'Flatten', zh: '扁平度' },
	'3d.nodeSize': { en: 'Node size', zh: '节点大小' },
	'3d.linkOpacity': { en: 'Link opacity', zh: '链接透明度' },
	'3d.twinkle': { en: 'Twinkle', zh: '星星眨眼' },
	'3d.twinkleOff': { en: 'Off', zh: '关' },
	'3d.size.degree': { en: 'Size: links', zh: '大小：链接数' },
	'3d.size.fileSize': { en: 'Size: file size', zh: '大小：文档量' },
	'3d.size.uniform': { en: 'Size: uniform', zh: '大小：一致' },
	'3d.sizeBy': { en: 'Size', zh: '大小' },
	'3d.sizeOption.degree': { en: 'Links', zh: '链接数' },
	'3d.sizeOption.fileSize': { en: 'File size', zh: '文档量' },
	'3d.sizeOption.uniform': { en: 'Uniform', zh: '一致' },
	'3d.colorTheme': { en: 'Color theme…', zh: '配色主题…' },
	'3d.importColors': { en: 'Import 2D colors', zh: '导入二维配色' },
	'3d.shuffleColors': { en: 'Shuffle colors', zh: '配色洗牌' },
	'3d.speed': { en: 'Speed', zh: '速度' },
	'3d.unresolvedShow': { en: 'Unresolved: show', zh: '未解析：显示' },
	'3d.unresolvedHide': { en: 'Unresolved: hide', zh: '未解析：隐藏' },
	'3d.orphansShow': { en: 'Orphans: show', zh: '孤儿：显示' },
	'3d.orphansHide': { en: 'Orphans: hide', zh: '孤儿：隐藏' },
	'3d.quality.auto': { en: 'Quality: auto', zh: '画质：自动' },
	'3d.quality.high': { en: 'Quality: high', zh: '画质：高' },
	'3d.quality.low': { en: 'Quality: low', zh: '画质：低' },
	'3d.quality.mobile': { en: 'Quality: mobile', zh: '画质：移动模拟' },
	'3d.help.drag': { en: 'Left drag = orbit · wheel = zoom', zh: '左键拖 = 环绕 · 滚轮 = 缩放' },
	'3d.help.pan': {
		en: 'Right drag / Cmd or Shift + left drag = pan',
		zh: '右键拖 / ⌘或⇧+左键拖 = 平移',
	},
	'3d.help.mac': { en: 'macOS treats Ctrl+click as right-click', zh: 'macOS 的 Ctrl+点击会被系统当右键' },
	'3d.help.fly': { en: 'WASD = fly · Q/E = rise/fall · Shift = fast', zh: 'WASD = 平飞 · Q/E = 升降 · Shift = 加速' },
	'3d.help.pick': { en: 'Click node = select and fly · ESC = clear', zh: '点击节点 = 选中飞行 · ESC = 取消' },
	'3d.help.keys': { en: 'F = fly to selected · R = overview', zh: 'F = 飞向选中 · R = 回总览' },
	'3d.help.slider': { en: 'Double-click a slider to reset it', zh: '双击滑杆 = 回默认值' },
	'3d.revealWait': { en: 'The map is still settling. Try reveal after it settles.', zh: '星系还在成形中，沉降后再试。' },
	'3d.workerFallback': {
		en: 'Mini World Map 3D: background layout worker is unavailable; using the main thread.',
		zh: 'Mini World Map 3D：后台线程不可用，已回退主线程布局。',
	},
	'3d.mobileCap': {
		en: 'Mobile quality: showing the top {cap} linked nodes out of {total}.',
		zh: '移动档：已显示链接最多的前 {cap} 个节点（共 {total}）。',
	},
	'3d.performanceMode': {
		en: 'Mini World Map 3D switched to performance mode. Change quality in Advanced.',
		zh: 'Mini World Map 3D：已自动切换到性能模式，可在高级页改回。',
	},
	'3d.importMissing': { en: 'No 2D graph color groups found in graph.json.', zh: '未找到自带图谱的颜色分组（graph.json）。' },
	'3d.importDone': { en: 'Imported {count} 2D color groups.', zh: '已导入 {count} 组 2D 图谱配色。' },
	'3d.shuffleMissing': { en: 'Import 2D colors before shuffling.', zh: '先导入二维图谱配色，才能洗牌。' },
	'3d.contextLost': { en: 'Rendering context lost. Click to rebuild.', zh: '渲染上下文丢失，点击重建。' },
	'3d.searchPlaceholder': { en: 'Search notes, press Enter to fly…', zh: '搜索笔记，回车飞过去…' },
	'3d.searchUnresolved': { en: 'Unresolved', zh: '未解析' },
	'3d.searchLinks': { en: '{count} links', zh: '{count} 链接' },
	'3d.card.unresolved': { en: 'Unresolved link (note does not exist)', zh: '未解析链接（笔记尚不存在）' },
	'3d.card.root': { en: 'Vault root', zh: '根目录' },
	'3d.card.stats': { en: '↩ {in} backlinks · → {out} outgoing', zh: '↩ {in} 反链 · → {out} 出链' },
	'3d.card.modified': { en: ' · modified {date}', zh: ' · 改于 {date}' },
	'3d.card.empty': { en: '(empty note)', zh: '（空笔记）' },
	'3d.bench.wait': { en: '{scenario}: waiting for layout to settle…', zh: '{scenario}：等待布局沉降…' },
	'3d.bench.orbit': { en: '{scenario}: 20s orbit FPS run…', zh: '{scenario}：20s 环绕测帧率…' },
	'3d.bench.done': { en: '{scenario} done: avg {fps} fps · {calls} calls', zh: '{scenario} 完成：avg {fps} fps · {calls} calls' },
	'3d.bench.s2Start': {
		en: 'S2: cold layout started. The interface should remain responsive.',
		zh: 'S2：冷布局开始（预算化 tick，期间界面应保持可用）…',
	},
	'3d.bench.s2Done': {
		en: 'S2 done: settled in {seconds}s / {ticks} ticks, longest block {longest}ms',
		zh: 'S2 完成：沉降 {seconds}s / {ticks} ticks，最长阻塞 {longest}ms',
	},

	'style.galaxy': { en: 'Galaxy', zh: '银河' },
	'style.nebula': { en: 'Nebula', zh: '星云' },
	'style.minimal': { en: 'Minimal', zh: '极简' },
	'style.fireworks': { en: 'Fireworks', zh: '烟火' },
	'color.hubble': { en: 'Hubble deep field', zh: '哈勃深空' },
	'color.tiktok': { en: 'Neon pop', zh: '抖音霓虹' },
	'color.sunset': { en: 'Sunset film', zh: '落日胶片' },
	'color.cyber': { en: 'Cyber city', zh: '赛博都市' },
	'color.matrix': { en: 'Matrix', zh: '黑客帝国' },
	'color.aurora': { en: 'Aurora', zh: '极光' },

	'settings.title': { en: 'Mini World Map', zh: 'Mini World Map' },
	'settings.defaultMode': { en: 'Default render mode', zh: '默认渲染模式' },
	'settings.defaultModeDesc': {
		en: '2D radial rings is the hierarchy-first map. 3D map uses the Galaxy renderer.',
		zh: '2D 环形图以层级为主；3D 地图使用 Galaxy 渲染器。',
	},
	'settings.languageDesc': { en: 'Language used by both 2D and 3D panels.', zh: '2D 与 3D 面板共同使用的语言。' },
	'settings.depthDesc': {
		en: 'How many hierarchy levels to render before deeper nodes are summarized by budgets.',
		zh: '渲染多少层级后由预算汇总更深节点。',
	},
	'settings.nodeLimitDesc': { en: 'Maximum visible nodes in the 2D radial map.', zh: '2D 环形图最多显示的节点数。' },
	'settings.linkLimitDesc': { en: 'Maximum aggregated note links to draw in 2D.', zh: '2D 中最多绘制的聚合笔记链接数。' },
	'settings.showLinksDesc': {
		en: 'Keeps note-link roads visible. Hover/link pinning still works when this is off.',
		zh: '保持笔记链接可见；关闭后悬停与链接固定仍可用。',
	},
	'settings.hoverDesc': { en: 'Choose what 2D hover highlights.', zh: '选择 2D 悬停高亮的内容。' },
	'settings.hoverTargetsDesc': { en: 'Choose whether nodes, note-link roads, or both react to hover and click.', zh: '选择节点、笔记链接道路或两者是否响应悬停和点击。' },
	'settings.labelsDesc': { en: 'Auto shows important names by zoom; hover only keeps the map quieter.', zh: '自动按缩放显示重要名称；仅悬停会更安静。' },
	'settings.spinDesc': { en: 'Optional radial ring motion in the 2D map.', zh: '2D 环形图中的可选环形运动。' },
	'settings.unresolvedDesc': { en: 'Represent unresolved internal links as temporary nodes.', zh: '将未解析内部链接显示为临时节点。' },
	'settings.ignoredDesc': { en: 'One folder path per line.', zh: '每行一个文件夹路径。' },
	'notice.rebuilt': { en: 'Mini World Map rebuilt', zh: 'Mini World Map 已重建' },
	'notice.openToBuild': { en: 'Open Mini World Map to build the index', zh: '打开 Mini World Map 后才能构建索引' },
	'notice.openToSearch': { en: 'Open Mini World Map to search.', zh: '打开 Mini World Map 后才能搜索。' },
};

export function t(language: Language, key: string, vars: Record<string, string | number> = {}): string {
	const template = STRINGS[key]?.[language] ?? STRINGS[key]?.en ?? key;
	return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function viewModeLabel(language: Language, mode: ViewMode): string {
	return t(language, `mode.${mode}`);
}

export function colorSchemeOptions(language: Language): [ColorScheme, string][] {
	return [
		['auto', t(language, 'theme.radialAuto')],
		['day', t(language, 'theme.day')],
		['night', t(language, 'theme.night')],
	];
}

export function languageOptions(language: Language): [Language, string][] {
	void language;
	return LANGUAGE_OPTIONS.map(([value, label]) => [value, label]);
}

export function hoverModeOptions(language: Language, values: readonly [HoverHighlightMode, string][]): [HoverHighlightMode, string][] {
	return values.map(([value]) => [value, t(language, `hover.${value}`)]);
}

export function hoverTargetOptions(language: Language, values: readonly [HoverTargetMode, string][]): [HoverTargetMode, string][] {
	return values.map(([value]) => [value, t(language, `hoverTarget.${value}`)]);
}

export function labelVisibilityOptions(language: Language, values: readonly [LabelVisibility, string][]): [LabelVisibility, string][] {
	return values.map(([value]) => [value, t(language, `labels.${value}`)]);
}

export function outsideDetailOptions(language: Language): [ExternalDetailMode, string][] {
	return [
		['grouped', t(language, 'outside.grouped')],
		['selected', t(language, 'outside.selected')],
		['exact', t(language, 'outside.exact')],
	];
}
