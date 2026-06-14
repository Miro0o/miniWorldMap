const {
  ItemView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  setIcon
} = require("obsidian");

const VIEW_TYPE_MINI_WORLD_MAP = "mini-world-map-view";
const ROOT_ID = "";
const ROOT_TITLE = "Vault";
const MAX_ATLAS_DEPTH = 80;
const MAX_RENDER_NODE_LIMIT = 20000;
const MAX_LINK_LIMIT = 30000;
const MAX_EXTERNAL_LINK_ANCHOR_LIMIT = 20000;
const MIN_CANVAS_ZOOM = 0.01;
const DEFAULT_MIN_CANVAS_ZOOM = 0.04;
const MAX_CANVAS_ZOOM = 2;
const ZOOM_SLIDER_STEPS = 1000;
const ZOOM_SLIDER_CURVE = 1.35;
const ZOOM_WHEEL_STEP = 1.045;
const ZOOM_BUTTON_STEP = 1.14;
const COLOR_SCHEME_OPTIONS = ["auto", "day", "night"];
const LABEL_VISIBILITY_OPTIONS = [
  ["auto", "Auto"],
  ["hover", "Hover only"]
];
const HOVER_HIGHLIGHT_MODE_OPTIONS = [
  ["none", "None"],
  ["note-links", "Note links"],
  ["hierarchy-parents", "Hierarchy parents"],
  ["hierarchy-direct-children", "Hierarchy direct children"],
  ["hierarchy-descendants", "Hierarchy all children"],
  ["hierarchy-parents-direct", "Hierarchy parents + direct"],
  ["hierarchy-all", "Hierarchy parents + all children"]
];
const LEGEND_ITEM_DEFINITIONS = [
  ["root", "root", "Current atlas root", "mwm-legend-root"],
  ["folder", "folder", "Folder / subtree", "mwm-legend-folder"],
  ["folder-meta", "folder+", "Folder with merged meta file", "mwm-legend-meta"],
  ["file", "file", "Markdown file", "mwm-legend-note"],
  ["outside", "outside", "Grouped outside branch", "mwm-legend-external"],
  ["outside-file", "outside file", "Exact linked file outside root", "mwm-legend-outside-file"],
  ["missing", "missing", "Unresolved internal link", "mwm-legend-unresolved"],
  ["tree", "tree", "Parent-child hierarchy", "mwm-legend-tree"],
  ["link", "link", "Internal file links", "mwm-legend-link"],
  ["outside-link", "outside link", "Crosses current root", "mwm-legend-link-external"],
  ["dashed-link", "dashed", "Includes unresolved links", "mwm-legend-link-unresolved"]
];
const DEFAULT_RING_SPACING = 960;
const MIN_RING_SPACING = 720;
const MAX_RING_SPACING = 2800;
const DEFAULT_NODE_SPACING = 126;
const MIN_NODE_SPACING = 72;
const MAX_NODE_SPACING = 360;
const DEFAULT_SWIRL_STRENGTH = 0;
const DEFAULT_SWIRL_BUTTON_STRENGTH = 32;
const MAX_SWIRL_STRENGTH = 100;
const SWIRL_FRAME_INTERVAL_MS = 42;
const SWIRL_BASE_SPEED_RAD_PER_SEC = 0.072;
const RING_JAGGED_BAND_FACTOR = 0.26;
const RING_JAGGED_MAX_FACTOR = 0.22;
const FAST_CANVAS_NODE_THRESHOLD = 2600;
const FAST_CANVAS_EDGE_THRESHOLD = 6500;
const FAST_CANVAS_LABEL_LIMIT = 90;
const MAX_DYNAMIC_ROUTE_EDGES = 12000;

const LEGACY_DEFAULT_SETTINGS = {
  atlasDepth: 4,
  focusSiblingLimit: 80,
  linkLimit: 220,
  renderNodeLimit: 1400,
  externalLinkAnchorLimit: 220,
  enableLinkHover: false
};

const DEFAULT_SETTINGS = {
  atlasDepth: 6,
  focusSiblingLimit: 160,
  linkLimit: 1200,
  renderNodeLimit: 4200,
  externalLinkAnchorLimit: 700,
  adaptiveDetail: true,
  includeUnresolvedLinks: true,
  showLinkOverlay: false,
  enableLinkHover: false,
  hoverHighlightMode: "hierarchy-all",
  showExternalLinks: true,
  externalDetailMode: "grouped",
  colorScheme: "auto",
  labelVisibility: "auto",
  swirlStrength: DEFAULT_SWIRL_STRENGTH,
  hiddenLegendItems: [],
  ignoreFolders: [
    ".git",
    ".obsidian"
  ]
};

const DEFAULT_NATIVE_GRAPH_SETTINGS = {
  showArrow: true,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1
};

class MiniWorldMapPlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.nativeGraphSettings = Object.assign({}, DEFAULT_NATIVE_GRAPH_SETTINGS);
    this.index = new WorldMapIndex(this.app, this.settings);
    this.rebuildTimer = null;
    this.themeRefreshTimer = null;
    this.themeObserver = null;

    this.registerView(
      VIEW_TYPE_MINI_WORLD_MAP,
      leaf => new MiniWorldMapView(leaf, this)
    );

    this.addRibbonIcon("network", "Open Mini World Map", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-map",
      name: "Open Mini World Map",
      callback: () => this.activateView()
    });

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild Mini World Map index",
      callback: () => this.rebuildIndex("manual")
    });

    this.addSettingTab(new MiniWorldMapSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuild("vault create")));
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile && file.extension === "md") this.scheduleRebuild("vault modify");
    }));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuild("vault delete")));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuild("vault rename")));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRebuild("metadata resolved")));
    this.installThemeRefresh();

    this.app.workspace.onLayoutReady(() => {
      this.loadNativeGraphSettings();
    });
  }

  onunload() {
    if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
    if (this.themeRefreshTimer) window.clearTimeout(this.themeRefreshTimer);
    if (this.themeObserver) this.themeObserver.disconnect();
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP);
    let leaf = leaves.first();

    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_MINI_WORLD_MAP, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    if (!this.index.ready) await this.rebuildIndex("open");
  }

  scheduleRebuild(reason) {
    if (!this.index.ready && !this.hasOpenMapView()) return;
    if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildIndex(reason);
    }, 900);
  }

  hasOpenMapView() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP).length > 0;
  }

  async rebuildIndex(reason) {
    try {
      const started = performance.now();
      this.index = new WorldMapIndex(this.app, this.settings);
      this.index.rebuild();
      const elapsed = Math.round(performance.now() - started);
      this.refreshViews();
      if (reason === "manual") {
        new Notice(`Mini World Map rebuilt in ${elapsed} ms`);
      }
    } catch (error) {
      console.error("Mini World Map index rebuild failed", error);
      new Notice("Mini World Map index rebuild failed. See developer console.");
    }
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
      const view = leaf.view;
      if (view && typeof view.refresh === "function") view.refresh();
    }
  }

  installThemeRefresh() {
    const refresh = () => this.scheduleThemeRefresh();
    if (this.app.workspace && typeof this.app.workspace.on === "function") {
      this.registerEvent(this.app.workspace.on("css-change", refresh));
    }

    if (typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.body) return;
    this.themeObserver = new MutationObserver(records => {
      if (records.some(record => record.attributeName === "class")) refresh();
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  scheduleThemeRefresh() {
    if (this.themeRefreshTimer) window.clearTimeout(this.themeRefreshTimer);
    this.themeRefreshTimer = window.setTimeout(() => {
      this.themeRefreshTimer = null;
      this.refreshViews();
    }, 60);
  }

  async saveSettings(options = {}) {
    await this.saveData(this.settings);
    if (options.rebuild !== false) this.scheduleRebuild("settings");
    else this.refreshViews();
  }

  async loadNativeGraphSettings() {
    try {
      const raw = await this.app.vault.adapter.read(".obsidian/graph.json");
      this.nativeGraphSettings = Object.assign(
        {},
        DEFAULT_NATIVE_GRAPH_SETTINGS,
        JSON.parse(raw || "{}")
      );
      this.refreshViews();
    } catch (error) {
      this.nativeGraphSettings = Object.assign({}, DEFAULT_NATIVE_GRAPH_SETTINGS);
    }
  }
}

class WorldMapIndex {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
    this.nodes = new Map();
    this.hierarchyEdges = [];
    this.linkEdges = [];
    this.childrenByParent = new Map();
    this.linkEdgesBySource = new Map();
    this.linkEdgesByTarget = new Map();
    this.folderRepresentatives = new Map();
    this.stats = {
      loadedEntries: 0,
      scannedMarkdown: 0,
      folders: 0,
      notes: 0,
      unresolved: 0,
      hierarchyEdges: 0,
      linkEdges: 0,
      maxDepth: 0
    };
    this.ready = false;
  }

  rebuild() {
    this.addNode({
      id: ROOT_ID,
      path: ROOT_ID,
      title: vaultRootTitle(this.app),
      type: "folder",
      parentId: null,
      depth: 0,
      noteCount: 0,
      linkCount: 0,
      backlinkCount: 0,
      descendantCount: 0
    });

    const { folders, markdownFiles, totalEntries } = this.collectVaultEntries();
    this.stats.loadedEntries = totalEntries;
    this.stats.scannedMarkdown = markdownFiles.length;

    for (const folder of folders) {
      this.addFolder(folder);
    }

    for (const file of markdownFiles) {
      this.ensureFolderPath(parentPath(file.path));
      this.addNote(file);
    }

    this.identifyFolderRepresentatives();
    this.buildHierarchyEdges();
    this.buildLinkEdges();
    this.computeStats();
    this.ready = true;
  }

  collectVaultEntries() {
    const folders = [];
    const markdownFiles = [];
    let totalEntries = 0;
    const root = typeof this.app.vault.getRoot === "function"
      ? this.app.vault.getRoot()
      : null;
    const stack = root && Array.isArray(root.children)
      ? root.children.slice()
      : [];

    while (stack.length) {
      const entry = stack.pop();
      totalEntries += 1;

      if (entry instanceof TFolder) {
        folders.push(entry);
        if (Array.isArray(entry.children)) {
          for (let index = entry.children.length - 1; index >= 0; index -= 1) {
            stack.push(entry.children[index]);
          }
        }
      } else if (entry instanceof TFile && entry.extension === "md") {
        markdownFiles.push(entry);
      }
    }

    return { folders, markdownFiles, totalEntries };
  }

  addFolder(folder) {
    this.ensureFolderPath(normalizeVaultPath(folder.path));
  }

  ensureFolderPath(folderPath) {
    const normalizedPath = normalizeVaultPath(folderPath);
    if (!normalizedPath) return;
    const parts = normalizedPath.split("/").filter(Boolean);
    let current = ROOT_ID;

    for (const part of parts) {
      const next = current ? `${current}/${part}` : part;
      if (this.shouldIgnorePath(next)) return;
      if (!this.nodes.has(next)) {
        this.addNode({
          id: next,
          path: next,
          title: basename(next),
          type: "folder",
          parentId: current,
          depth: depthOfPath(next),
          noteCount: 0,
          linkCount: 0,
          backlinkCount: 0,
          descendantCount: 0
        });
      }
      current = next;
    }
  }

  addNote(file) {
    if (this.shouldIgnorePath(file.path)) return;

    const parentId = normalizeVaultPath(parentPath(file.path));
    this.addNode({
      id: file.path,
      path: file.path,
      title: file.basename,
      type: "note",
      parentId,
      depth: depthOfPath(file.path),
      noteCount: 1,
      linkCount: 0,
      backlinkCount: 0,
      descendantCount: 0,
      file
    });
  }

  addUnresolvedNode(sourcePath, linkText) {
    const id = `unresolved:${sourcePath}:${linkText}`;
    if (!this.nodes.has(id)) {
      const source = this.nodes.get(sourcePath);
      this.addNode({
        id,
        path: linkText,
        title: linkText,
        type: "unresolved",
        parentId: source ? source.parentId : ROOT_ID,
        depth: source ? source.depth + 1 : 1,
        noteCount: 0,
        linkCount: 0,
        backlinkCount: 0,
        descendantCount: 0
      });
    }
    return id;
  }

  addNode(node) {
    if (!node || this.nodes.has(node.id)) return;
    this.nodes.set(node.id, node);
  }

  identifyFolderRepresentatives() {
    const notes = Array.from(this.nodes.values()).filter(node => node.type === "note");
    const notesByParent = new Map();

    for (const note of notes) {
      if (!notesByParent.has(note.parentId)) notesByParent.set(note.parentId, []);
      notesByParent.get(note.parentId).push(note);
    }

    for (const folder of this.nodes.values()) {
      if (folder.type !== "folder" || folder.id === ROOT_ID) continue;
      const siblings = notesByParent.get(folder.id) || [];
      const folderTitle = comparableTitle(folder.title);
      const representative = siblings.find(note => comparableTitle(note.title) === folderTitle);
      if (representative) {
        folder.representativeFile = representative.path;
        representative.isRepresentativeFile = true;
        representative.representativeFor = folder.id;
        this.folderRepresentatives.set(folder.id, representative.path);
      }
    }
  }

  buildHierarchyEdges() {
    this.childrenByParent.clear();

    for (const node of this.nodes.values()) {
      if (node.parentId === null) continue;
      if (!this.nodes.has(node.parentId)) continue;
      this.hierarchyEdges.push({
        id: `hierarchy:${node.parentId}->${node.id}`,
        type: "hierarchy",
        source: node.parentId,
        target: node.id,
        weight: 1
      });
      if (!this.childrenByParent.has(node.parentId)) this.childrenByParent.set(node.parentId, []);
      this.childrenByParent.get(node.parentId).push(node.id);
    }

    for (const children of this.childrenByParent.values()) {
      children.sort((a, b) => compareNodes(this.nodes.get(a), this.nodes.get(b)));
    }
  }

  buildLinkEdges() {
    const resolved = this.app.metadataCache.resolvedLinks || {};
    const unresolved = this.app.metadataCache.unresolvedLinks || {};

    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (!this.nodes.has(sourcePath) || this.shouldIgnorePath(sourcePath)) continue;
      for (const [targetPath, count] of Object.entries(targets || {})) {
        if (!this.nodes.has(targetPath) || this.shouldIgnorePath(targetPath)) continue;
        this.addLinkEdge(sourcePath, targetPath, Math.max(1, Number(count) || 1), "link");
      }
    }

    if (this.settings.includeUnresolvedLinks) {
      for (const [sourcePath, targets] of Object.entries(unresolved)) {
        if (!this.nodes.has(sourcePath) || this.shouldIgnorePath(sourcePath)) continue;
        for (const [linkText, count] of Object.entries(targets || {})) {
          const targetId = this.addUnresolvedNode(sourcePath, linkText);
          this.addLinkEdge(sourcePath, targetId, Math.max(1, Number(count) || 1), "unresolved-link");
        }
      }
    }
  }

  addLinkEdge(source, target, weight, type) {
    if (source === target) return;
    const edge = {
      id: `${type}:${source}->${target}:${this.linkEdges.length}`,
      type,
      source,
      target,
      weight
    };
    this.linkEdges.push(edge);

    const sourceNode = this.nodes.get(source);
    const targetNode = this.nodes.get(target);
    if (sourceNode) sourceNode.linkCount += weight;
    if (targetNode) targetNode.backlinkCount += weight;

    if (!this.linkEdgesBySource.has(source)) this.linkEdgesBySource.set(source, []);
    if (!this.linkEdgesByTarget.has(target)) this.linkEdgesByTarget.set(target, []);
    this.linkEdgesBySource.get(source).push(edge);
    this.linkEdgesByTarget.get(target).push(edge);
  }

  computeStats() {
    const sorted = Array.from(this.nodes.values()).sort((a, b) => b.depth - a.depth);

    for (const node of sorted) {
      node.descendantCount = node.type === "note" ? 1 : node.noteCount;
      if (!node.parentId || !this.nodes.has(node.parentId)) continue;
      const parent = this.nodes.get(node.parentId);
      const subtreeNoteCount = node.type === "note" ? 1 : node.noteCount;
      parent.descendantCount += subtreeNoteCount;
      parent.noteCount += subtreeNoteCount;
      parent.linkCount += node.linkCount;
      parent.backlinkCount += node.backlinkCount;
    }

    this.stats = {
      loadedEntries: this.stats.loadedEntries,
      scannedMarkdown: this.stats.scannedMarkdown,
      folders: Array.from(this.nodes.values()).filter(node => node.type === "folder").length,
      notes: Array.from(this.nodes.values()).filter(node => node.type === "note").length,
      unresolved: Array.from(this.nodes.values()).filter(node => node.type === "unresolved").length,
      hierarchyEdges: this.hierarchyEdges.length,
      linkEdges: this.linkEdges.length,
      maxDepth: Math.max(...Array.from(this.nodes.values()).map(node => node.depth), 0)
    };
  }

  shouldIgnorePath(path) {
    if (!path) return false;
    const ignores = this.settings.ignoreFolders || [];
    return ignores.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  }

  getActiveNotePath() {
    const active = this.app.workspace.getActiveFile();
    if (active && this.nodes.has(active.path)) return active.path;
    if (this.nodes.has("Universe, Self-Awareness, and Intelligence.md")) {
      return "Universe, Self-Awareness, and Intelligence.md";
    }
    const firstNote = Array.from(this.nodes.values()).find(node => node.type === "note");
    return firstNote ? firstNote.id : null;
  }

  buildVisibleGraph(state) {
    if (!this.ready) return { nodes: [], hierarchyEdges: [], linkEdges: [], rootId: ROOT_ID };

    if (state.mode === "focus") return this.buildFocusGraph(state);
    return this.buildAtlasGraph(state);
  }

  buildAtlasGraph(state) {
    const rootId = this.nodes.has(state.rootPath) ? state.rootPath : ROOT_ID;
    const rootDepth = this.nodes.get(rootId).depth;
    const maxDepth = clampNumber(
      state.atlasDepth === undefined || state.atlasDepth === null ? this.settings.atlasDepth : state.atlasDepth,
      1,
      MAX_ATLAS_DEPTH,
      this.settings.atlasDepth
    );
    const visible = new Set();
    const query = normalizedQuery(state.search);

    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      const node = this.nodes.get(id);
      if (!node) continue;
      const relDepth = Math.max(0, node.depth - rootDepth);
      const isWithinDepth = relDepth <= maxDepth;
      const matchesSearch = query && nodeMatches(node, query);

      if (isWithinDepth || matchesSearch) {
        visible.add(id);
        if (matchesSearch) this.addAncestors(id, visible, rootId);
      }

      if (isWithinDepth || matchesSearch) {
        const children = this.childrenByParent.get(id) || [];
        for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
      }
    }

    if (query) {
      for (const node of this.nodes.values()) {
        if (nodeMatches(node, query)) {
          visible.add(node.id);
          this.addAncestors(node.id, visible, rootId);
        }
      }
    }

    this.addDirectFilesForVisibleFolders(visible);
    return this.materializeVisibleGraph(visible, rootId, state);
  }

  buildFocusGraph(state) {
    const activePath = state.focusPath && this.nodes.has(state.focusPath)
      ? state.focusPath
      : this.getActiveNotePath();
    const rootId = activePath || ROOT_ID;
    const visible = new Set([ROOT_ID]);
    const siblingLimit = Math.max(10, Number(this.settings.focusSiblingLimit) || 80);

    if (activePath) {
      visible.add(activePath);
      this.addAncestors(activePath, visible, ROOT_ID);

      const active = this.nodes.get(activePath);
      if (active && active.parentId) {
        const siblings = this.childrenByParent.get(active.parentId) || [];
        for (const siblingId of siblings.slice(0, siblingLimit)) visible.add(siblingId);
      }

      const connected = [
        ...(this.linkEdgesBySource.get(activePath) || []),
        ...(this.linkEdgesByTarget.get(activePath) || [])
      ];
      connected
        .sort((a, b) => b.weight - a.weight)
        .slice(0, Math.max(30, siblingLimit))
        .forEach(edge => {
          visible.add(edge.source);
          visible.add(edge.target);
          this.addAncestors(edge.source, visible, ROOT_ID);
          this.addAncestors(edge.target, visible, ROOT_ID);
        });
    }

    const query = normalizedQuery(state.search);
    if (query) {
      for (const node of this.nodes.values()) {
        if (nodeMatches(node, query)) {
          visible.add(node.id);
          this.addAncestors(node.id, visible, ROOT_ID);
        }
      }
    }

    this.addDirectFilesForVisibleFolders(visible);
    return this.materializeVisibleGraph(visible, ROOT_ID, Object.assign({}, state, { focusPath: activePath, rootPath: ROOT_ID }), rootId);
  }

  addDirectFilesForVisibleFolders(visible) {
    for (const id of Array.from(visible)) {
      const node = this.nodes.get(id);
      if (!node || node.type !== "folder") continue;
      for (const childId of this.childrenByParent.get(id) || []) {
        const child = this.nodes.get(childId);
        if (child && (child.type === "note" || child.type === "unresolved")) {
          visible.add(childId);
        }
      }
    }
  }

  addAncestors(id, visible, stopId) {
    let current = this.nodes.get(id);
    while (current && current.parentId !== null) {
      visible.add(current.id);
      if (current.id === stopId) break;
      current = this.nodes.get(current.parentId);
    }
    visible.add(stopId || ROOT_ID);
  }

  materializeVisibleGraph(visible, rootId, state, focusId) {
    let nodes = Array.from(visible)
      .map(id => this.nodes.get(id))
      .filter(Boolean)
      .sort(compareNodes);

    const budget = this.applyNodeBudget(nodes, rootId, state, focusId);
    nodes = budget.nodes;
    nodes = this.foldRepresentativeNodes(nodes);

    const nodeSet = new Set(nodes.map(node => node.id));
    const hierarchyEdges = this.hierarchyEdges.filter(edge => nodeSet.has(edge.source) && nodeSet.has(edge.target));
    const linkBundle = this.aggregateVisibleLinkEdges(nodeSet, state, rootId);
    nodes = nodes.concat(linkBundle.externalNodes);

    const nodesById = new Map(nodes.map(node => [node.id, node]));

    return {
      nodes,
      nodesById,
      hierarchyEdges: hierarchyEdges.concat(linkBundle.externalHierarchyEdges),
      linkEdges: linkBundle.linkEdges,
      hoverLinkEdges: linkBundle.hoverLinkEdges,
      rootId,
      focusId: this.visualNodeId(focusId) || null,
      hiddenNodeCount: budget.hiddenNodeCount,
      externalNodeCount: linkBundle.externalNodes.length,
      externalFileCount: linkBundle.externalFileCount || 0,
      externalGroupCount: linkBundle.externalGroupCount || 0
    };
  }

  foldRepresentativeNodes(nodes) {
    const visibleIds = new Set(nodes.map(node => node.id));
    return nodes.filter(node => {
      if (!node || !node.isRepresentativeFile) return true;
      return !visibleIds.has(node.representativeFor);
    });
  }

  visualNodeId(id) {
    const node = this.nodes.get(id);
    if (node && node.isRepresentativeFile && node.representativeFor && this.nodes.has(node.representativeFor)) {
      return node.representativeFor;
    }
    return id;
  }

  aggregateVisibleLinkEdges(visible, state, rootId) {
    const needsHoverLinks = hoverHighlightsNoteLinks(state.hoverHighlightMode);
    if (!state.showLinkOverlay && !needsHoverLinks) return {
      linkEdges: [],
      hoverLinkEdges: [],
      externalNodes: [],
      externalHierarchyEdges: [],
      externalFileCount: 0,
      externalGroupCount: 0
    };
    const aggregate = new Map();
    const externalNodes = new Map();
    const externalHierarchyEdges = [];
    const showExternalLinks = state.showExternalLinks !== false;
    const externalDetailMode = state.externalDetailMode || this.settings.externalDetailMode || DEFAULT_SETTINGS.externalDetailMode;
    const externalLimit = clampNumber(
      state.externalLinkAnchorLimit === undefined || state.externalLinkAnchorLimit === null ? this.settings.externalLinkAnchorLimit : state.externalLinkAnchorLimit,
      0,
      MAX_EXTERNAL_LINK_ANCHOR_LIMIT,
      DEFAULT_SETTINGS.externalLinkAnchorLimit
    );
    const externalContext = { fileCount: 0, groupIds: new Set(), overflowId: null };

    for (const edge of this.linkEdges) {
      let source = this.nearestVisibleAncestor(edge.source, visible, rootId);
      let target = this.nearestVisibleAncestor(edge.target, visible, rootId);
      let externalCount = 0;

      if (showExternalLinks && rootId !== ROOT_ID) {
        if (!source && target) {
          source = this.externalEndpointFor(
            edge.source,
            rootId,
            externalNodes,
            externalHierarchyEdges,
            externalLimit,
            externalContext,
            this.shouldUseExactExternalEndpoint(edge, state, externalDetailMode, target)
          );
          if (source) externalCount = 1;
        }
        if (source && !target) {
          target = this.externalEndpointFor(
            edge.target,
            rootId,
            externalNodes,
            externalHierarchyEdges,
            externalLimit,
            externalContext,
            this.shouldUseExactExternalEndpoint(edge, state, externalDetailMode, source)
          );
          if (target) externalCount = 1;
        }
      }

      if (!source || !target || source === target) continue;
      const key = `${source}->${target}`;
      const existing = aggregate.get(key) || {
        id: `visible-link:${key}`,
        type: "visible-link",
        source,
        target,
        weight: 0,
        rawCount: 0,
        unresolvedCount: 0,
        externalCount: 0
      };
      existing.weight += edge.weight;
      existing.rawCount += 1;
      if (edge.type === "unresolved-link") existing.unresolvedCount += 1;
      existing.externalCount += externalCount;
      aggregate.set(key, existing);
    }

    const allLinkEdges = Array.from(aggregate.values())
      .sort((a, b) => linkRenderScore(b) - linkRenderScore(a));
    const linkLimit = clampNumber(
      state.linkLimit === undefined || state.linkLimit === null ? this.settings.linkLimit : state.linkLimit,
      0,
      MAX_LINK_LIMIT,
      DEFAULT_SETTINGS.linkLimit
    );
    const showAllLinks = Boolean(state.showCompleteRoot);
    const completeLinkLimit = showAllLinks ? MAX_LINK_LIMIT : linkLimit;
    const linkEdges = state.showLinkOverlay ? allLinkEdges.slice(0, completeLinkLimit) : [];
    const hoverLinkEdges = showAllLinks && state.showLinkOverlay ? linkEdges : allLinkEdges;

    const usedExternalIds = new Set();
    const externalNodeEdges = showAllLinks || externalDetailMode === "grouped" || needsHoverLinks
      ? hoverLinkEdges
      : linkEdges;
    for (const edge of externalNodeEdges) {
      if (externalNodes.has(edge.source)) usedExternalIds.add(edge.source);
      if (externalNodes.has(edge.target)) usedExternalIds.add(edge.target);
    }

    const collectedExternalNodes = this.collectUsedExternalNodes(usedExternalIds, externalNodes);

    return {
      linkEdges,
      hoverLinkEdges,
      externalNodes: collectedExternalNodes,
      externalHierarchyEdges: externalHierarchyEdges.filter(edge => usedExternalIds.has(edge.target)),
      externalFileCount: collectedExternalNodes.filter(node => node.externalProxy).length,
      externalGroupCount: collectedExternalNodes.filter(node => node.type === "external" && !node.externalProxy).length
    };
  }

  nearestVisibleAncestor(id, visible, rootId) {
    let current = this.nodes.get(id);
    while (current) {
      if (visible.has(current.id)) return current.id;
      if (current.id === rootId) return rootId;
      current = current.parentId === null ? null : this.nodes.get(current.parentId);
    }
    return visible.has(ROOT_ID) ? ROOT_ID : null;
  }

  collectUsedExternalNodes(usedExternalIds, externalNodes) {
    const collected = new Map();
    for (const id of usedExternalIds) {
      const node = externalNodes.get(id);
      if (!node) continue;
      if (node.externalParentId && externalNodes.has(node.externalParentId)) {
        collected.set(node.externalParentId, externalNodes.get(node.externalParentId));
      }
      collected.set(id, node);
    }
    return Array.from(collected.values());
  }

  shouldUseExactExternalEndpoint(edge, state, detailMode, visibleEndpoint) {
    if (detailMode === "exact") return true;
    if (detailMode === "grouped") return false;

    const selectedNodeId = state.selectedNodeId;
    if (selectedNodeId !== null && selectedNodeId !== undefined && (
      edge.source === selectedNodeId
      || edge.target === selectedNodeId
      || visibleEndpoint === selectedNodeId
    )) {
      return true;
    }

    const selectedLink = state.selectedLink;
    return Boolean(selectedLink && (
      selectedLink.source === visibleEndpoint
      || selectedLink.target === visibleEndpoint
      || selectedLink.source === edge.source
      || selectedLink.target === edge.target
    ));
  }

  externalEndpointFor(nodeId, rootId, externalNodes, externalHierarchyEdges, externalLimit, context, exactFiles) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    const anchorPath = externalAnchorPath(node, rootId);
    if (!anchorPath) return null;

    const groupId = this.externalGroupFor(anchorPath, rootId, externalNodes, context);
    if (!groupId) return null;
    if (!exactFiles) return groupId;

    if (node.type !== "note" && node.type !== "unresolved") return groupId;

    if (externalNodes.has(node.id)) return node.id;
    if (context.fileCount >= externalLimit) return this.externalOverflowFor(rootId, groupId, externalNodes, externalHierarchyEdges, context);

    externalNodes.set(node.id, Object.assign({}, node, {
      externalProxy: true,
      externalParentId: groupId,
      externalAnchorPath: anchorPath
    }));
    context.fileCount += 1;
    externalHierarchyEdges.push({
      id: `external-hierarchy:${groupId}->${node.id}`,
      type: "external-hierarchy",
      source: groupId,
      target: node.id,
      weight: 1
    });

    return node.id;
  }

  externalGroupFor(anchorPath, rootId, externalNodes, context) {
    const id = `external-group:${rootId}:${anchorPath}`;
    if (!externalNodes.has(id)) {
      const anchorNode = this.nodes.get(anchorPath);
      externalNodes.set(id, {
        id,
        path: anchorPath,
        title: `Outside: ${anchorNode ? anchorNode.title : basename(anchorPath)}`,
        type: "external",
        parentId: null,
        depth: (this.nodes.get(rootId)?.depth || 0) + 1,
        noteCount: anchorNode ? (anchorNode.noteCount || anchorNode.descendantCount || 0) : 0,
        linkCount: 0,
        backlinkCount: 0,
        descendantCount: anchorNode ? (anchorNode.descendantCount || anchorNode.noteCount || 0) : 0,
        externalAnchorPath: anchorPath
      });
      context.groupIds.add(id);
    }
    return id;
  }

  externalOverflowFor(rootId, groupId, externalNodes, externalHierarchyEdges, context) {
    if (!context.overflowId) {
      context.overflowId = `external-overflow:${rootId}`;
      externalNodes.set(context.overflowId, {
        id: context.overflowId,
        path: "outside current root",
        title: "More outside files",
        type: "external",
        parentId: null,
        depth: (this.nodes.get(rootId)?.depth || 0) + 1,
        noteCount: 0,
        linkCount: 0,
        backlinkCount: 0,
        descendantCount: 0,
        externalProxy: true,
        externalParentId: groupId,
        externalAnchorPath: null
      });
      externalHierarchyEdges.push({
        id: `external-hierarchy:${groupId}->${context.overflowId}`,
        type: "external-hierarchy",
        source: groupId,
        target: context.overflowId,
        weight: 1
      });
    }
    return context.overflowId;
  }

  applyNodeBudget(nodes, rootId, state, focusId) {
    if (state.showCompleteRoot && nodes.length <= MAX_RENDER_NODE_LIMIT) {
      return { nodes, hiddenNodeCount: 0 };
    }
    const limit = clampNumber(
      state.nodeLimit === undefined || state.nodeLimit === null ? this.settings.renderNodeLimit : state.nodeLimit,
      200,
      MAX_RENDER_NODE_LIMIT,
      DEFAULT_SETTINGS.renderNodeLimit
    );
    if (!limit || nodes.length <= limit) {
      return { nodes, hiddenNodeCount: 0 };
    }

    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const childrenByParent = buildBudgetChildrenByParent(nodes);
    const query = normalizedQuery(state.search);
    const keep = new Set([rootId ?? ROOT_ID, focusId].filter(id => id !== null && id !== undefined));
    const candidates = nodes
      .slice()
      .sort((a, b) => nodeRenderScore(b, rootId, focusId, query) - nodeRenderScore(a, rootId, focusId, query));
    const fileCandidates = candidates.filter(node => node.type === "note" || node.type === "unresolved");
    const targetFileCount = Math.min(
      fileCandidates.length,
      Math.max(24, Math.floor(limit * (state.showCompleteRoot ? 0.46 : 0.38)))
    );
    let keptFileCount = 0;
    this.addDirectFileChildrenToSet(
      rootId ?? ROOT_ID,
      keep,
      nodeById,
      childrenByParent,
      limit,
      state.showCompleteRoot ? 128 : 64
    );

    for (const node of fileCandidates) {
      if (keep.size >= limit || keptFileCount >= targetFileCount) break;
      const before = keep.size;
      this.addNodeWithAncestorsToSet(node.id, keep, nodeById, limit);
      if (keep.has(node.id) && keep.size > before) keptFileCount += 1;
    }

    for (const node of candidates) {
      if (keep.size >= limit) break;
      this.addNodeWithAncestorsToSet(node.id, keep, nodeById, limit);
      if (node.type === "folder") {
        this.addDirectFileChildrenToSet(
          node.id,
          keep,
          nodeById,
          childrenByParent,
          limit,
          state.showCompleteRoot ? 18 : 8
        );
      }
    }

    const keptNodes = nodes.filter(node => keep.has(node.id));
    return {
      nodes: keptNodes,
      hiddenNodeCount: Math.max(0, nodes.length - keptNodes.length)
    };
  }

  addNodeWithAncestorsToSet(id, keep, nodeById, limit) {
    let current = nodeById.get(id);
    const chain = [];
    while (current && !keep.has(current.id)) {
      chain.push(current.id);
      current = current.parentId === null ? null : nodeById.get(current.parentId);
    }

    for (let i = chain.length - 1; i >= 0; i -= 1) {
      if (keep.size >= limit) break;
      keep.add(chain[i]);
    }
  }

  addDirectFileChildrenToSet(parentId, keep, nodeById, childrenByParent, limit, perParentLimit) {
    const children = childrenByParent.get(parentId) || [];
    if (!children.length || keep.size >= limit) return;

    let added = 0;
    for (const childId of children) {
      if (keep.size >= limit || added >= perParentLimit) break;
      if (keep.has(childId)) continue;
      const child = nodeById.get(childId);
      if (!child || (child.type !== "note" && child.type !== "unresolved")) continue;
      keep.add(childId);
      added += 1;
    }
  }
}

class MiniWorldMapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const hoverHighlightMode = normalizeHoverHighlightMode(plugin.settings.hoverHighlightMode);
    this.state = {
      mode: "atlas",
      search: "",
      rootPath: ROOT_ID,
      atlasDepth: plugin.settings.atlasDepth,
      linkLimit: plugin.settings.linkLimit,
      nodeLimit: plugin.settings.renderNodeLimit,
      externalLinkAnchorLimit: plugin.settings.externalLinkAnchorLimit,
      autoDetail: plugin.settings.adaptiveDetail,
      showLinkOverlay: plugin.settings.showLinkOverlay,
      enableLinkHover: hoverHighlightsNoteLinks(hoverHighlightMode),
      hoverHighlightMode,
      showExternalLinks: plugin.settings.showExternalLinks,
      externalDetailMode: plugin.settings.externalDetailMode || DEFAULT_SETTINGS.externalDetailMode,
      colorScheme: plugin.settings.colorScheme || DEFAULT_SETTINGS.colorScheme,
      labelVisibility: normalizeLabelVisibility(plugin.settings.labelVisibility),
      focusPath: null,
      showCompleteRoot: false,
      zoom: 1,
      columnSpacing: DEFAULT_RING_SPACING,
      rowSpacing: DEFAULT_NODE_SPACING,
      swirlStrength: clampNumber(plugin.settings.swirlStrength, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH),
      hiddenLegendItems: Array.isArray(plugin.settings.hiddenLegendItems) ? plugin.settings.hiddenLegendItems.slice() : [],
      sidePanelWidth: 360,
      sidePage: "inspect",
      fullscreen: false
    };
    this.preCompleteState = null;
    this.positions = new Map();
    this.selectedNodeId = null;
    this.selectedLink = null;
    this.lastLayout = null;
    this.renderTimer = null;
    this.activeHighlightElements = new Set();
    this.nodeElementsById = new Map();
    this.edgeElementsByNode = new Map();
    this.edgeElementsById = new Map();
    this.canvas = null;
    this.canvasData = null;
    this.canvasPalette = null;
    this.canvasPanX = 0;
    this.canvasPanY = 0;
    this.canvasDpr = 1;
    this.canvasViewportSize = { width: 0, height: 0 };
    this.dragState = null;
    this.hoverNodeId = null;
    this.hoverLink = null;
    this.graphViewSignature = null;
    this.viewInitialized = false;
    this.lastCanvasBundle = null;
    this.canvasVisualNodes = new Map();
    this.canvasVisualEdges = new Map();
    this.canvasVisualInitialized = false;
    this.canvasAnimationFrame = null;
    this.canvasSettleTimer = null;
    this.canvasSpringAnimationFrame = null;
    this.canvasSpringState = null;
    this.canvasSwirlAnimationFrame = null;
    this.canvasSwirlStartedAt = 0;
    this.canvasSwirlLastFrameAt = 0;
    this.nextCanvasDrawMode = "full";
    this.canvasInteractionUntil = 0;
    this.lastCanvasFrameAt = 0;
    this.adaptiveInitialized = false;
    this.lastAutoTuneAt = 0;
    this.autoTuneCount = 0;
    this.lastRenderMs = 0;
    this.viewportStateByKey = new Map();
    this.currentViewportStateKey = null;
  }

  getViewType() {
    return VIEW_TYPE_MINI_WORLD_MAP;
  }

  getDisplayText() {
    return "Mini World Map";
  }

  getIcon() {
    return "network";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("mini-world-map-view");
    this.syncColorSchemeClass();
    this.renderShell();
    if (!this.plugin.index.ready) await this.plugin.rebuildIndex("open");
    this.refresh();
  }

  async onClose() {
    if (this.resizeCleanup) this.resizeCleanup();
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    if (this.canvasAnimationFrame) window.cancelAnimationFrame(this.canvasAnimationFrame);
    if (this.canvasSettleTimer) window.clearTimeout(this.canvasSettleTimer);
    this.cancelCanvasSpringBack();
    this.cancelCanvasSwirlAnimation();
    this.contentEl.empty();
  }

  refresh() {
    if (!this.containerEl || !this.graphHost) return;
    this.render();
  }

  renderShell() {
    this.contentEl.empty();

    this.metaEl = this.contentEl.createDiv({ cls: "mwm-meta" });

    const body = this.contentEl.createDiv({ cls: "mwm-body" });
    this.bodyEl = body;
    this.bodyEl.style.setProperty("--mwm-side-width", `${this.state.sidePanelWidth}px`);
    this.graphHost = body.createDiv({ cls: "mwm-graph-host" });
    this.graphHost.addEventListener("wheel", evt => {
      evt.preventDefault();
      this.zoomAtClientPoint(evt.clientX, evt.clientY, evt.deltaY > 0 ? -1 : 1);
    }, { passive: false });
    this.splitter = body.createDiv({
      cls: "mwm-splitter",
      attr: { role: "separator", title: "Drag to resize right panel" }
    });
    this.installPanelResize();
    this.sidePanel = body.createDiv({ cls: "mwm-side-panel" });

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.requestCanvasDraw("full"));
      observer.observe(this.graphHost);
      this.resizeCleanup = () => observer.disconnect();
    }
  }

  createIconButton(parent, icon, title, onClick, extraClass) {
    const button = parent.createEl("button", {
      cls: extraClass ? `mwm-icon-button ${extraClass}` : "mwm-icon-button",
      attr: { type: "button", "aria-label": title, title }
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  sidePanelPages() {
    return [
      ["inspect", "Inspect", "info"],
      ["view", "View", "navigation"],
      ["controls", "Controls", "sliders-horizontal"],
      ["defaults", "Defaults", "settings"]
    ];
  }

  clearControlRefs() {
    this.searchInput = null;
    this.depthInput = null;
    this.linkInput = null;
    this.nodeInput = null;
    this.autoToggle = null;
    this.linkToggle = null;
    this.linkHoverSelect = null;
    this.externalToggle = null;
    this.externalModeSelect = null;
    this.externalLimitInput = null;
    this.zoomInput = null;
    this.zoomLabel = null;
    this.columnInput = null;
    this.rowInput = null;
    this.labelVisibilitySelect = null;
    this.swirlInput = null;
    this.swirlLabel = null;
    this.panelControlRefs = new Map();
  }

  capturePanelFocus() {
    const doc = this.contentEl?.ownerDocument;
    const active = doc?.activeElement;
    if (!active || !this.sidePanel || !this.sidePanel.contains(active)) return null;
    const key = active.getAttribute("data-mwm-control");
    if (!key) return null;
    return {
      key,
      start: typeof active.selectionStart === "number" ? active.selectionStart : null,
      end: typeof active.selectionEnd === "number" ? active.selectionEnd : null
    };
  }

  restorePanelFocus(focusState) {
    if (!focusState || !this.panelControlRefs) return;
    const element = this.panelControlRefs.get(focusState.key);
    if (!element) return;
    element.focus({ preventScroll: true });
    if (focusState.start !== null && typeof element.setSelectionRange === "function") {
      element.setSelectionRange(focusState.start, focusState.end ?? focusState.start);
    }
  }

  registerPanelControl(key, element) {
    if (!element) return element;
    element.setAttribute("data-mwm-control", key);
    if (!this.panelControlRefs) this.panelControlRefs = new Map();
    this.panelControlRefs.set(key, element);
    return element;
  }

  getSidePanelTarget() {
    return this.sidePanelContent || this.sidePanel;
  }

  createPanelPageTitle(parent, title, desc) {
    parent.createDiv({ cls: "mwm-panel-page-title", text: title });
    if (desc) parent.createDiv({ cls: "mwm-panel-page-desc", text: desc });
  }

  createPanelSection(parent, title) {
    const section = parent.createDiv({ cls: "mwm-panel-section" });
    if (title) section.createDiv({ cls: "mwm-side-heading", text: title });
    return section;
  }

  createPanelAction(parent, icon, label, onClick, active = false) {
    const button = parent.createEl("button", {
      cls: active ? "mwm-panel-action is-active" : "mwm-panel-action",
      attr: { type: "button", title: label }
    });
    setIcon(button, icon);
    button.createSpan({ text: label });
    button.addEventListener("click", onClick);
    return button;
  }

  createPanelText(parent, key, label, value, placeholder, onInput) {
    const field = parent.createEl("label", { cls: "mwm-panel-field" });
    field.createSpan({ cls: "mwm-panel-label", text: label });
    const input = field.createEl("input", {
      attr: { type: "search", placeholder, value }
    });
    this.registerPanelControl(key, input);
    input.addEventListener("input", () => onInput(input.value, input));
    return input;
  }

  createPanelNumber(parent, key, label, value, attr, onChange) {
    const field = parent.createEl("label", { cls: "mwm-panel-field" });
    field.createSpan({ cls: "mwm-panel-label", text: label });
    const input = field.createEl("input", {
      attr: Object.assign({ type: "number", value: String(value) }, attr || {})
    });
    this.registerPanelControl(key, input);
    input.addEventListener("change", () => onChange(input.value, input));
    return input;
  }

  createPanelRange(parent, key, label, value, attr, onInput) {
    const field = parent.createEl("label", { cls: "mwm-panel-field mwm-panel-range-field" });
    const header = field.createDiv({ cls: "mwm-panel-field-header" });
    header.createSpan({ cls: "mwm-panel-label", text: label });
    const valueEl = header.createSpan({ cls: "mwm-value", text: `${Math.round(this.state.zoom * 100)}%` });
    const input = field.createEl("input", {
      attr: Object.assign({ type: "range", value: String(value) }, attr || {})
    });
    this.registerPanelControl(key, input);
    input.addEventListener("input", () => onInput(input.value, input, valueEl));
    return { input, valueEl };
  }

  createPanelToggle(parent, key, label, value, onChange) {
    const field = parent.createEl("label", { cls: "mwm-panel-toggle" });
    const input = field.createEl("input", { attr: { type: "checkbox" } });
    input.checked = Boolean(value);
    this.registerPanelControl(key, input);
    field.createSpan({ text: label });
    input.addEventListener("change", () => onChange(input.checked, input));
    return input;
  }

  createPanelSelect(parent, key, label, value, options, onChange) {
    const field = parent.createEl("label", { cls: "mwm-panel-field" });
    field.createSpan({ cls: "mwm-panel-label", text: label });
    const select = field.createEl("select", { cls: "mwm-select" });
    for (const [optionValue, optionLabel] of options) {
      select.createEl("option", { attr: { value: optionValue }, text: optionLabel });
    }
    select.value = value;
    this.registerPanelControl(key, select);
    select.addEventListener("change", () => onChange(select.value, select));
    return select;
  }

  createPanelTextArea(parent, key, label, value, onChange) {
    const field = parent.createEl("label", { cls: "mwm-panel-field" });
    field.createSpan({ cls: "mwm-panel-label", text: label });
    const textArea = field.createEl("textarea");
    textArea.value = value;
    this.registerPanelControl(key, textArea);
    textArea.addEventListener("change", () => onChange(textArea.value, textArea));
    return textArea;
  }

  render() {
    this.syncColorSchemeClass();
    const index = this.plugin.index;
    if (!index.ready) {
      this.graphHost.empty();
      this.graphHost.createDiv({ cls: "mwm-empty", text: "Building map..." });
      return;
    }

    if (this.state.autoDetail && !this.adaptiveInitialized) {
      this.applyInitialAdaptiveDefaults(index);
    }

    if (this.searchInput && this.searchInput.value !== this.state.search) {
      this.searchInput.value = this.state.search;
    }
    if (this.depthInput) this.depthInput.value = String(this.state.atlasDepth);
    if (this.linkInput) this.linkInput.value = String(this.state.linkLimit);
    if (this.nodeInput) this.nodeInput.value = String(this.state.nodeLimit);
    if (this.autoToggle) this.autoToggle.checked = this.state.autoDetail;
    if (this.linkToggle) this.linkToggle.checked = this.state.showLinkOverlay;
    if (this.linkHoverSelect) this.linkHoverSelect.value = normalizeHoverHighlightMode(this.state.hoverHighlightMode);
    if (this.externalToggle) this.externalToggle.checked = this.state.showExternalLinks;
    if (this.externalModeSelect) this.externalModeSelect.value = this.state.externalDetailMode;
    if (this.externalLimitInput) this.externalLimitInput.value = String(this.state.externalLinkAnchorLimit);
    this.syncZoomControls();
    if (this.columnInput) this.columnInput.value = String(this.state.columnSpacing);
    if (this.rowInput) this.rowInput.value = String(this.state.rowSpacing);
    if (this.labelVisibilitySelect) this.labelVisibilitySelect.value = normalizeLabelVisibility(this.state.labelVisibility);
    if (this.swirlInput) {
      this.swirlInput.value = String(this.state.swirlStrength);
      if (this.swirlLabel) this.swirlLabel.textContent = `${Math.round(this.state.swirlStrength)}%`;
    }
    if (this.bodyEl) this.bodyEl.style.setProperty("--mwm-side-width", `${this.state.sidePanelWidth}px`);
    if (this.contentEl) this.contentEl.classList.toggle("is-fullscreen", this.state.fullscreen);

    const started = performance.now();
    const graphState = Object.assign({}, this.state, {
      selectedNodeId: this.selectedNodeId,
      selectedLink: this.selectedLink
    });
    const graph = index.buildVisibleGraph(graphState);
    if (this.applyPreLayoutPressureGuard(graph)) return;
    const layout = layoutVisibleGraph(index, graph, this.state);
    this.lastLayout = layout;
    this.positions = layout.positions;

    this.renderGraph(index, graph, layout);
    if (!this.state.fullscreen) this.renderSidePanel(index, graph);
    this.lastRenderMs = Math.round(performance.now() - started);
    this.renderMeta(index, graph, layout);
    this.maybeAutoTune(index, graph, this.lastRenderMs);
  }

  renderMeta(index, graph, layout) {
    this.metaEl.empty();
    const rootNode = index.nodes.get(graph.rootId);
    const activeNode = graph.focusId ? index.nodes.get(graph.focusId) : null;
    const chips = [
      `${this.state.mode}`,
      `${graph.nodes.length} nodes`,
      `${graph.linkEdges.length} link overlays`,
      `${graph.externalFileCount || 0} outside files`,
      `${graph.externalGroupCount || 0} outside groups`,
      `outside: ${this.state.externalDetailMode}`,
      `${index.stats.notes} notes`,
      `${index.stats.folders} folders`,
      `${index.stats.scannedMarkdown} scanned md`,
      `${this.lastRenderMs || 0} ms`
    ];

    if (this.state.autoDetail) chips.push("auto");
    if (this.state.showCompleteRoot) chips.push("complete root");
    if (rootNode && this.state.mode === "atlas" && rootNode.id !== ROOT_ID) {
      chips.push(`root: ${rootNode.title}`);
    }
    if (activeNode && this.state.mode === "focus") {
      chips.push(`focus: ${activeNode.title}`);
    }
    if (this.state.search) chips.push(`search: ${this.state.search}`);
    if (normalizeHoverHighlightMode(this.state.hoverHighlightMode) !== "none") {
      chips.push(`hover: ${hoverHighlightModeLabel(this.state.hoverHighlightMode)}`);
    }
    if (graph.hiddenNodeCount) chips.push(`${graph.hiddenNodeCount} hidden by node limit`);

    for (const chip of chips) {
      this.metaEl.createSpan({ cls: "mwm-chip", text: chip });
    }

    if (layout.trimmed) {
      this.metaEl.createSpan({ cls: "mwm-chip mwm-chip-warn", text: "large view" });
    }
  }

  scheduleRender(delay = 80) {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, delay);
  }

  disableAutoDetail() {
    if (!this.state.autoDetail) return;
    this.state.autoDetail = false;
    if (this.autoToggle) this.autoToggle.checked = false;
  }

  resetAdaptiveTuning() {
    if (!this.state.autoDetail) return;
    this.adaptiveInitialized = false;
    this.autoTuneCount = 0;
  }

  toggleFullscreen() {
    this.state.fullscreen = !this.state.fullscreen;
    this.render();
  }

  resetToVaultRoot() {
    this.state.rootPath = ROOT_ID;
    this.state.mode = "atlas";
    this.state.showCompleteRoot = false;
    this.viewInitialized = false;
    this.resetAdaptiveTuning();
    this.render();
  }

  syncColorSchemeClass() {
    if (!this.contentEl) return;
    const scheme = normalizeColorScheme(this.state.colorScheme);
    this.state.colorScheme = scheme;
    this.contentEl.classList.toggle("is-day-scheme", scheme === "day");
    this.contentEl.classList.toggle("is-night-scheme", scheme === "night");
    this.contentEl.setAttribute("data-mwm-color-scheme", scheme);
  }

  setColorScheme(scheme, persist = true) {
    const next = normalizeColorScheme(scheme);
    this.state.colorScheme = next;
    this.plugin.settings.colorScheme = next;
    this.syncColorSchemeClass();
    this.canvasPalette = this.readCanvasPalette();
    this.requestCanvasDraw("full");
    if (!this.state.fullscreen && this.lastCanvasBundle) {
      this.renderSidePanel(this.lastCanvasBundle.index, this.lastCanvasBundle.graph);
    }
    if (persist) {
      for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
        const view = leaf.view;
        if (view && view !== this && typeof view.setColorScheme === "function") {
          view.setColorScheme(next, false);
        }
      }
      void this.plugin.saveSettings({ rebuild: false });
    }
  }

  cycleColorScheme() {
    this.setColorScheme(nextColorScheme(this.state.colorScheme));
  }

  disableCompleteRoot() {
    if (!this.state.showCompleteRoot) return;
    this.state.showCompleteRoot = false;
    this.preCompleteState = null;
  }

  exitCompleteRoot() {
    if (!this.state.showCompleteRoot) return;
    const previous = this.preCompleteState;
    this.state.showCompleteRoot = false;
    this.preCompleteState = null;
    if (previous) {
      Object.assign(this.state, previous);
    }
  }

  showCompleteCurrentRoot() {
    const index = this.plugin.index;
    if (!index.ready) return;

    const currentGraphRoot = this.lastCanvasBundle?.graph?.rootId;
    const rootId = currentGraphRoot !== null && currentGraphRoot !== undefined && index.nodes.has(currentGraphRoot)
      ? currentGraphRoot
      : this.state.mode === "atlas" && index.nodes.has(this.state.rootPath)
        ? this.state.rootPath
        : ROOT_ID;
    const profile = this.completeRootProfile(index, rootId);

    this.preCompleteState = {
      mode: this.state.mode,
      rootPath: this.state.rootPath,
      atlasDepth: this.state.atlasDepth,
      nodeLimit: this.state.nodeLimit,
      linkLimit: this.state.linkLimit,
      externalLinkAnchorLimit: this.state.externalLinkAnchorLimit,
      autoDetail: this.state.autoDetail,
      showExternalLinks: this.state.showExternalLinks,
      externalDetailMode: this.state.externalDetailMode
    };
    this.state.mode = "atlas";
    this.state.rootPath = rootId;
    this.state.showCompleteRoot = true;
    this.state.autoDetail = false;
    this.state.showExternalLinks = true;
    this.state.externalDetailMode = "exact";
    this.state.atlasDepth = profile.depth;
    this.state.nodeLimit = profile.nodeLimit;
    this.state.linkLimit = profile.linkLimit;
    this.state.externalLinkAnchorLimit = profile.externalLimit;
    this.viewInitialized = false;
    this.adaptiveInitialized = true;
    this.render();
  }

  completeRootProfile(index, rootId) {
    const root = index.nodes.get(rootId) || index.nodes.get(ROOT_ID);
    const rootDepth = root ? root.depth || 0 : 0;
    const insideIds = new Set();
    let maxRelDepth = 1;

    for (const node of index.nodes.values()) {
      if (!nodeWithinRoot(index, node, rootId)) continue;
      insideIds.add(node.id);
      maxRelDepth = Math.max(maxRelDepth, Math.max(0, (node.depth || 0) - rootDepth));
    }

    let linkCount = 0;
    const exactExternalIds = new Set();
    for (const edge of index.linkEdges) {
      const sourceInside = insideIds.has(edge.source);
      const targetInside = insideIds.has(edge.target);
      if (!sourceInside && !targetInside) continue;
      linkCount += 1;
      if (sourceInside !== targetInside) exactExternalIds.add(sourceInside ? edge.target : edge.source);
    }

    return {
      depth: clampNumber(maxRelDepth, 1, MAX_ATLAS_DEPTH, DEFAULT_SETTINGS.atlasDepth),
      nodeLimit: clampNumber(insideIds.size + exactExternalIds.size + 64, 200, MAX_RENDER_NODE_LIMIT, DEFAULT_SETTINGS.renderNodeLimit),
      linkLimit: clampNumber(linkCount + 64, 0, MAX_LINK_LIMIT, DEFAULT_SETTINGS.linkLimit),
      externalLimit: clampNumber(exactExternalIds.size + 64, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, DEFAULT_SETTINGS.externalLinkAnchorLimit)
    };
  }

  shouldRerenderForSelection() {
    return false;
  }

  clearSelection(index, graph) {
    const hadSelection = this.selectedNodeId !== null && this.selectedNodeId !== undefined || Boolean(this.selectedLink);
    this.selectedNodeId = null;
    this.selectedLink = null;
    this.hoverNodeId = null;
    this.hoverLink = null;

    if (hadSelection && this.shouldRerenderForSelection()) {
      this.render();
      return;
    }

    this.clearHoverClasses();
    if (this.graphHost) this.graphHost.classList.remove("is-hovering");
    if (this.graphHost) this.graphHost.classList.remove("is-pointing");
    this.requestCanvasDraw("full");
    if (!this.state.fullscreen) this.renderSidePanel(index, graph);
  }

  applyInitialAdaptiveDefaults(index) {
    const root = index.nodes.get(this.state.mode === "atlas" ? this.state.rootPath : ROOT_ID);
    const localNotes = root ? (root.noteCount || root.descendantCount || index.stats.notes) : index.stats.notes;
    const visiblePressure = Math.max(1, Math.min(index.stats.notes || 1, localNotes || 1));

    if (visiblePressure < 1500) {
      this.state.atlasDepth = Math.max(this.state.atlasDepth, 8);
      this.state.nodeLimit = Math.max(this.state.nodeLimit, 6200);
      this.state.linkLimit = Math.max(this.state.linkLimit, 2200);
      this.state.externalLinkAnchorLimit = Math.max(this.state.externalLinkAnchorLimit, 900);
    } else if (visiblePressure < 4200) {
      this.state.atlasDepth = Math.max(this.state.atlasDepth, 7);
      this.state.nodeLimit = Math.max(this.state.nodeLimit, 5200);
      this.state.linkLimit = Math.max(this.state.linkLimit, 1700);
      this.state.externalLinkAnchorLimit = Math.max(this.state.externalLinkAnchorLimit, 750);
    } else if (visiblePressure < 9000) {
      this.state.atlasDepth = Math.max(this.state.atlasDepth, 5);
      this.state.nodeLimit = Math.max(this.state.nodeLimit, 3600);
      this.state.linkLimit = Math.max(this.state.linkLimit, 1000);
      this.state.externalLinkAnchorLimit = Math.max(this.state.externalLinkAnchorLimit, 500);
    } else {
      this.state.atlasDepth = Math.max(4, Math.min(this.state.atlasDepth, 6));
      this.state.nodeLimit = Math.max(this.state.nodeLimit, 2600);
      this.state.linkLimit = Math.max(this.state.linkLimit, 700);
      this.state.externalLinkAnchorLimit = Math.max(this.state.externalLinkAnchorLimit, 300);
    }

    this.adaptiveInitialized = true;
  }

  applyPreLayoutPressureGuard(graph) {
    if (!this.state.autoDetail || this.state.search || this.state.showCompleteRoot) return false;

    const pressure = graph.nodes.length
      + graph.linkEdges.length * 1.7
      + (graph.externalFileCount || 0) * 5
      + (graph.externalGroupCount || 0) * 1.4
      + (graph.hiddenNodeCount || 0) * 0.15;

    if (pressure < 9000 && graph.externalFileCount < 520) return false;

    let changed = false;
    if (this.state.externalDetailMode === "exact" && graph.externalFileCount > 480) {
      this.state.externalDetailMode = "selected";
      changed = true;
    }
    const hasSelectedNode = this.selectedNodeId !== null && this.selectedNodeId !== undefined;
    if (this.state.externalDetailMode === "selected" && !hasSelectedNode && !this.selectedLink && graph.externalFileCount > 0) {
      this.state.externalDetailMode = "grouped";
      changed = true;
    }
    if (this.state.externalLinkAnchorLimit > 260) {
      this.state.externalLinkAnchorLimit = Math.max(220, Math.floor(this.state.externalLinkAnchorLimit * 0.72));
      changed = true;
    }
    if (this.state.linkLimit > 650) {
      this.state.linkLimit = Math.max(560, Math.floor(this.state.linkLimit * 0.74));
      changed = true;
    }
    if (this.state.nodeLimit > 2400) {
      this.state.nodeLimit = Math.max(2200, Math.floor(this.state.nodeLimit * 0.78));
      changed = true;
    }
    if (pressure > 15000 && this.state.atlasDepth > 3) {
      this.state.atlasDepth -= 1;
      changed = true;
    }

    if (changed) {
      this.autoTuneCount += 1;
      this.lastAutoTuneAt = performance.now();
      this.graphHost.empty();
      this.graphHost.createDiv({ cls: "mwm-empty", text: "Reducing map detail..." });
      this.scheduleRender(60);
      return true;
    }
    return false;
  }

  maybeAutoTune(index, graph, elapsedMs) {
    if (!this.state.autoDetail || this.state.search || this.state.showCompleteRoot) return;
    if (this.autoTuneCount >= 9) return;

    const now = performance.now();
    if (now - this.lastAutoTuneAt < 900) return;

    const pressure = graph.nodes.length
      + graph.linkEdges.length * 1.5
      + (graph.externalFileCount || 0) * 4;
    const tooHeavy = elapsedMs > 480 || pressure > 9000 || graph.nodes.length > this.state.nodeLimit * 1.08;
    const veryLight = elapsedMs > 0
      && elapsedMs < 70
      && graph.hiddenNodeCount === 0
      && graph.externalFileCount < 80
      && graph.nodes.length > Math.max(80, this.state.nodeLimit * 0.35);

    let changed = false;
    if (tooHeavy) {
      this.state.linkLimit = Math.max(520, Math.floor(this.state.linkLimit * 0.76));
      this.state.nodeLimit = Math.max(2100, Math.floor(this.state.nodeLimit * 0.8));
      this.state.externalLinkAnchorLimit = Math.max(220, Math.floor(this.state.externalLinkAnchorLimit * 0.74));
      if (this.state.externalDetailMode === "exact" && (elapsedMs > 420 || graph.externalFileCount > 480)) {
        this.state.externalDetailMode = "selected";
      }
      if ((elapsedMs > 850 || pressure > 15000) && this.state.atlasDepth > 3) this.state.atlasDepth -= 1;
      changed = true;
    } else if (veryLight) {
      const maxDepth = Math.min(MAX_ATLAS_DEPTH, index.stats.maxDepth || MAX_ATLAS_DEPTH);
      if (this.state.atlasDepth < maxDepth) {
        this.state.atlasDepth += 1;
        changed = true;
      }
      if (this.state.nodeLimit < 12000) {
        this.state.nodeLimit = Math.min(12000, this.state.nodeLimit + 700);
        changed = true;
      }
      if (this.state.linkLimit < 6000) {
        this.state.linkLimit = Math.min(6000, this.state.linkLimit + 260);
        changed = true;
      }
    }

    if (changed) {
      this.autoTuneCount += 1;
      this.lastAutoTuneAt = now;
      this.scheduleRender(120);
    }
  }

  renderGraph(index, graph, layout) {
    this.cancelCanvasSpringBack();
    this.cancelCanvasSwirlAnimation();
    this.graphHost.empty();
    this.graphHost.classList.remove("is-hovering");
    this.graphHost.classList.remove("is-panning");
    this.graphHost.classList.remove("is-pointing");
    this.activeHighlightElements.clear();
    this.nodeElementsById.clear();
    this.edgeElementsByNode.clear();
    this.edgeElementsById.clear();
    this.hoverNodeId = null;
    this.hoverLink = null;

    const canvas = this.graphHost.createEl("canvas", {
      cls: "mwm-canvas",
      attr: {
        role: "img",
        "aria-label": "Mini World Map graph",
        tabindex: "0"
      }
    });
    this.canvas = canvas;
    this.renderFloatingCanvasControls();
    this.renderFloatingThemeButton();
    this.canvasPalette = this.readCanvasPalette();

    const query = normalizedQuery(this.state.search);
    this.canvasData = buildCanvasGraphData(
      index,
      graph,
      layout,
      query,
      this.plugin.nativeGraphSettings || DEFAULT_NATIVE_GRAPH_SETTINGS,
      { includeHoverLinks: hoverHighlightsNoteLinks(this.state.hoverHighlightMode) }
    );
    this.lastCanvasBundle = { index, graph, layout };

    const viewport = this.canvasViewport();
    const viewportStateKey = this.viewportStateKey(graph);
    const changingViewport = this.currentViewportStateKey !== viewportStateKey;
    if (changingViewport) this.saveViewportState();
    const minZoom = this.canvasMinZoom(viewport, layout);
    const maxZoom = this.canvasMaxZoom(viewport, layout);
    const requestedWholeMap = this.state.zoom <= minZoom + 0.0005;
    this.state.zoom = clampFloat(this.state.zoom, minZoom, maxZoom, 1);
    this.sizeCanvasToViewport(canvas, viewport);
    const signature = [
      graph.rootId,
      graph.focusId || "",
      graph.nodes.length,
      graph.linkEdges.length,
      Math.round(layout.width),
      Math.round(layout.height)
    ].join("|");

    if (!this.viewInitialized || this.graphViewSignature !== signature || changingViewport) {
      const restored = this.restoreViewportState(viewportStateKey, viewport, layout);
      if (!restored) {
        this.state.zoom = this.defaultZoomForLayout(layout, viewport);
        this.centerCanvasView(layout, viewport, this.state.mode === "focus" ? (graph.focusId || graph.rootId) : null);
      }
      this.currentViewportStateKey = viewportStateKey;
      this.graphViewSignature = signature;
      this.viewInitialized = true;
      this.canvasVisualNodes.clear();
      this.canvasVisualEdges.clear();
      this.canvasVisualInitialized = false;
    } else if (requestedWholeMap) {
      this.centerCanvasView(layout, viewport, null);
    }
    this.syncZoomControls();

    this.installCanvasEvents(canvas);
    this.drawCanvasGraph();
    this.startCanvasSwirlAnimation();
  }

  renderFloatingThemeButton() {
    if (!this.graphHost) return;
    const scheme = normalizeColorScheme(this.state.colorScheme);
    const next = nextColorScheme(scheme);
    const button = this.graphHost.createEl("button", {
      cls: `mwm-floating-button mwm-theme-button is-${scheme}`,
      attr: {
        type: "button",
        "aria-label": `Theme: ${colorSchemeLabel(scheme)}`,
        title: `Theme: ${colorSchemeLabel(scheme)}. Click for ${colorSchemeLabel(next)}.`
      }
    });
    setIcon(button, colorSchemeIcon(scheme));
    button.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.cycleColorScheme();
    });
  }

  renderFloatingCanvasControls() {
    if (!this.graphHost) return;
    const controls = this.graphHost.createDiv({ cls: "mwm-floating-controls" });

    const rootButton = controls.createEl("button", {
      cls: "mwm-floating-button",
      attr: { type: "button", "aria-label": "Vault root", title: "Vault root" }
    });
    setIcon(rootButton, "home");
    rootButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.resetToVaultRoot();
    });

    const fullscreenButton = controls.createEl("button", {
      cls: "mwm-floating-button",
      attr: {
        type: "button",
        "aria-label": this.state.fullscreen ? "Exit full screen" : "Full screen",
        title: this.state.fullscreen ? "Exit full screen" : "Full screen"
      }
    });
    setIcon(fullscreenButton, this.state.fullscreen ? "minimize-2" : "maximize-2");
    fullscreenButton.addEventListener("click", evt => {
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleFullscreen();
    });
  }

  readCanvasPalette() {
    const fallbackBg = resolveCssColor(this.contentEl, "--mwm-graph-bg", "#1e1e1e");
    const fallbackLine = resolveCssColor(this.contentEl, "--mwm-graph-line", "rgba(128, 128, 128, 0.45)");
    const fallbackNode = resolveCssColor(this.contentEl, "--mwm-node", "#8f8f8f");
    const fallbackFocus = resolveCssColor(this.contentEl, "--mwm-node-focused", "#8b7cf6");
    const fallbackText = resolveCssColor(this.contentEl, "--mwm-text", "#dddddd");
    const graphLine = fallbackLine;
    const graphNode = fallbackNode;
    const graphFocus = fallbackFocus;
    const graphCircle = resolveCssColor(this.contentEl, "--mwm-node-focused", graphFocus);
    const graphText = fallbackText;
    const graphFillHighlight = resolveCssColor(this.contentEl, "--mwm-node-glow", graphFocus);
    const graphLineHighlight = resolveCssColor(this.contentEl, "--mwm-link-highlight", graphFocus);
    const graphUnresolved = resolveCssColor(this.contentEl, "--mwm-unresolved", fallbackNode);
    return {
      bg: fallbackBg,
      line: graphLine,
      lineHighlight: graphLineHighlight,
      node: graphNode,
      note: resolveCssColor(this.contentEl, "--mwm-note", graphNode),
      folder: resolveCssColor(this.contentEl, "--mwm-folder", graphNode),
      folderMeta: resolveCssColor(this.contentEl, "--mwm-folder-meta", graphNode),
      folderRing: resolveCssColor(this.contentEl, "--mwm-folder-ring", graphLine),
      tree: resolveCssColor(this.contentEl, "--mwm-tree", graphLine),
      ringGuide: resolveCssColor(this.contentEl, "--mwm-ring-guide", graphLine),
      fileRing: resolveCssColor(this.contentEl, "--mwm-file-ring", graphNode),
      focus: graphFocus,
      circle: graphCircle,
      text: graphText,
      labelText: resolveCssColor(this.contentEl, "--mwm-label-text", graphText),
      labelStroke: resolveCssColor(this.contentEl, "--mwm-label-stroke", fallbackBg),
      link: resolveCssColor(this.contentEl, "--mwm-link", graphLine),
      external: resolveCssColor(this.contentEl, "--mwm-external", graphCircle),
      externalLink: resolveCssColor(this.contentEl, "--mwm-external-link", graphCircle),
      unresolved: graphUnresolved,
      muted: resolveCssColor(this.contentEl, "--mwm-muted", "#999999"),
      stroke: resolveCssColor(this.contentEl, "--mwm-node-stroke", "#111111"),
      glow: graphFillHighlight,
      fontFamily: getComputedStyle(this.contentEl).fontFamily || "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    };
  }

  canvasViewport() {
    return {
      width: Math.max(1, Math.floor(this.graphHost?.clientWidth || 900)),
      height: Math.max(1, Math.floor(this.graphHost?.clientHeight || 520))
    };
  }

  sizeCanvasToViewport(canvas, viewport) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    if (canvas.width !== Math.floor(width * dpr)) canvas.width = Math.floor(width * dpr);
    if (canvas.height !== Math.floor(height * dpr)) canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    this.canvasDpr = dpr;
    this.canvasViewportSize = { width, height };
  }

  canvasMinZoom(viewport = this.canvasViewport(), layout = this.lastLayout) {
    if (!layout || !viewport) return DEFAULT_MIN_CANVAS_ZOOM;
    const fitZoom = fitZoomForLayout(layout, viewport, 32);
    return clampFloat(Math.min(DEFAULT_MIN_CANVAS_ZOOM, fitZoom), MIN_CANVAS_ZOOM, DEFAULT_MIN_CANVAS_ZOOM, DEFAULT_MIN_CANVAS_ZOOM);
  }

  canvasMaxZoom(viewport = this.canvasViewport(), layout = this.lastLayout) {
    return MAX_CANVAS_ZOOM;
  }

  viewportStateKey(graph) {
    const root = graph?.rootId || ROOT_ID;
    const focus = graph?.focusId || "";
    const detail = this.state.showCompleteRoot ? "complete" : "bounded";
    return `${this.state.mode}|${root}|${focus}|${detail}`;
  }

  saveViewportState() {
    if (!this.currentViewportStateKey) return;
    if (!Number.isFinite(this.state.zoom) || !Number.isFinite(this.canvasPanX) || !Number.isFinite(this.canvasPanY)) return;
    this.viewportStateByKey.set(this.currentViewportStateKey, {
      zoom: this.state.zoom,
      panX: this.canvasPanX,
      panY: this.canvasPanY
    });
  }

  restoreViewportState(key, viewport, layout) {
    const saved = this.viewportStateByKey.get(key);
    if (!saved) return false;
    const minZoom = this.canvasMinZoom(viewport, layout);
    const maxZoom = this.canvasMaxZoom(viewport, layout);
    this.state.zoom = clampFloat(saved.zoom, minZoom, maxZoom, this.defaultZoomForLayout(layout, viewport));
    this.canvasPanX = Number.isFinite(saved.panX) ? saved.panX : 0;
    this.canvasPanY = Number.isFinite(saved.panY) ? saved.panY : 0;
    return true;
  }

  defaultZoomForLayout(layout, viewport = this.canvasViewport()) {
    const minZoom = this.canvasMinZoom(viewport, layout);
    const maxZoom = this.canvasMaxZoom(viewport, layout);
    const fitZoom = fitZoomForLayout(layout, viewport, 42);
    return clampFloat(fitZoom * 1.08, minZoom, maxZoom, minZoom);
  }

  centerCanvasView(layout, viewport = this.canvasViewport(), rootId = ROOT_ID) {
    const zoom = clampFloat(this.state.zoom, this.canvasMinZoom(viewport, layout), this.canvasMaxZoom(viewport, layout), 1);
    const rootPoint = rootId === null ? null : (layout.positions.get(rootId) || layout.positions.get(ROOT_ID));
    const centerX = rootPoint ? rootPoint.x : layout.width / 2;
    const centerY = rootPoint ? rootPoint.y : layout.height / 2;
    this.canvasPanX = viewport.width / 2 - centerX * zoom;
    this.canvasPanY = viewport.height / 2 - centerY * zoom;
    this.saveViewportState();
  }

  installCanvasEvents(canvas) {
    canvas.addEventListener("pointerdown", evt => {
      if (evt.button !== 0) return;
      this.cancelCanvasSpringBack();
      const point = this.canvasEventPoint(evt);
      const hit = this.hitTestCanvas(point);
      if (hit.node && hit.node.node.id !== this.lastCanvasBundle?.graph?.rootId) {
        const world = this.screenToWorld(point);
        this.dragState = {
          mode: "node",
          pointerId: evt.pointerId,
          nodeId: hit.node.node.id,
          startClientX: evt.clientX,
          startClientY: evt.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          nodeStartX: hit.node.point.x,
          nodeStartY: hit.node.point.y,
          lastDx: 0,
          lastDy: 0,
          moved: false,
          suppressClick: false
        };
        canvas.setPointerCapture?.(evt.pointerId);
        this.hoverNodeId = hit.node.node.id;
        this.hoverLink = null;
        this.graphHost.classList.add("is-panning", "is-pointing");
        this.requestCanvasDraw("interactive");
        return;
      }

      this.dragState = {
        mode: "pan",
        pointerId: evt.pointerId,
        startClientX: evt.clientX,
        startClientY: evt.clientY,
        startPanX: this.canvasPanX,
        startPanY: this.canvasPanY,
        moved: false,
        suppressClick: false
      };
      canvas.setPointerCapture?.(evt.pointerId);
      this.graphHost.classList.add("is-panning");
      this.updateCanvasHover(point);
    });

    canvas.addEventListener("pointermove", evt => {
      const point = this.canvasEventPoint(evt);
      if (this.dragState) {
        const dx = evt.clientX - this.dragState.startClientX;
        const dy = evt.clientY - this.dragState.startClientY;
        this.dragState.moved = this.dragState.moved || Math.hypot(dx, dy) > 3;
        this.dragState.suppressClick = this.dragState.moved;
        if (this.dragState.mode === "node") {
          const world = this.screenToWorld(point);
          const worldDx = world.x - this.dragState.startWorldX;
          const worldDy = world.y - this.dragState.startWorldY;
          const stepDx = worldDx - (this.dragState.lastDx || 0);
          const stepDy = worldDy - (this.dragState.lastDy || 0);
          this.dragState.lastDx = worldDx;
          this.dragState.lastDy = worldDy;

          const item = this.canvasData?.nodesById?.get(this.dragState.nodeId);
          if (item) {
            item.point.x = this.dragState.nodeStartX + worldDx;
            item.point.y = this.dragState.nodeStartY + worldDy;
            this.updateCanvasPointPolar(item.point);
            this.applyNodeDragGravity(item, stepDx, stepDy);
            if (!this.canvasNeedsFastDraw()) this.resolveCanvasNodeOverlapsAround(item.node.id, 2);
            this.hoverNodeId = item.node.id;
            this.hoverLink = null;
          }
          this.requestCanvasDraw("interactive");
          return;
        }

        this.canvasPanX = this.dragState.startPanX + dx;
        this.canvasPanY = this.dragState.startPanY + dy;
        this.saveViewportState();
        this.requestCanvasDraw("interactive");
        return;
      }
      this.updateCanvasHover(point);
    });

    canvas.addEventListener("pointerup", evt => {
      const wasDragging = Boolean(this.dragState && this.dragState.suppressClick);
      const draggedNodeId = this.dragState && this.dragState.mode === "node" ? this.dragState.nodeId : null;
      canvas.releasePointerCapture?.(evt.pointerId);
      this.dragState = null;
      this.graphHost.classList.remove("is-panning");
      if (draggedNodeId && wasDragging) {
        if (!this.canvasNeedsFastDraw()) this.resolveCanvasNodeOverlapsAround(draggedNodeId, 3);
        this.startCanvasSpringBack(draggedNodeId);
        return;
      }
      if (wasDragging) {
        this.requestCanvasDraw("full");
        return;
      }
      if (!wasDragging) this.activateCanvasAt(this.canvasEventPoint(evt), evt);
    });

    canvas.addEventListener("pointerleave", () => {
      if (this.dragState) return;
      this.hoverNodeId = null;
      this.hoverLink = null;
      this.graphHost.classList.remove("is-hovering");
      this.graphHost.classList.remove("is-pointing");
      this.requestCanvasDraw("full");
    });

    canvas.addEventListener("dblclick", evt => {
      const hit = this.hitTestCanvas(this.canvasEventPoint(evt));
      if (!hit.node) return;
      evt.preventDefault();
      evt.stopPropagation();
      const node = hit.node.node;
      if (node.type === "note") {
        this.openNode(node.id, evt);
      } else if (node.type === "folder") {
        this.state.mode = "atlas";
        this.state.rootPath = node.id;
        this.state.showCompleteRoot = false;
        this.viewInitialized = false;
        this.resetAdaptiveTuning();
        this.render();
      }
    });

    canvas.addEventListener("contextmenu", evt => {
      const hit = this.hitTestCanvas(this.canvasEventPoint(evt));
      if (!hit.node) return;
      evt.preventDefault();
      this.showNodeMenu(evt, hit.node.node);
    });
  }

  updateCanvasPointPolar(point) {
    if (!point) return;
    const centerX = Number.isFinite(point.centerX) ? point.centerX : 0;
    const centerY = Number.isFinite(point.centerY) ? point.centerY : 0;
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    point.radius = Math.hypot(dx, dy);
    point.angle = Math.atan2(dy, dx);
    point.labelSide = labelSideForAngle(point.angle);
  }

  applyNodeDragGravity(draggedItem, dx, dy) {
    if (!draggedItem || (!dx && !dy) || !this.canvasData) return;
    const nodeId = draggedItem.node.id;
    const edges = this.canvasData.edgesByNode.get(nodeId) || [];
    if (!edges.length) return;

    const gravity = clampFloat(Math.sqrt(Math.max(1, draggedItem.radius)) / 9.2, 0.06, 0.34, 0.12);
    const moved = new Set([nodeId]);
    for (const edge of edges) {
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      if (moved.has(otherId)) continue;
      const other = this.canvasData.nodesById.get(otherId);
      if (!other || other.node.id === this.lastCanvasBundle?.graph?.rootId) continue;

      const hierarchy = edge.edge && edge.edge.type && String(edge.edge.type).includes("hierarchy");
      const strength = gravity * (hierarchy ? 0.42 : 0.18);
      other.point.x += dx * strength;
      other.point.y += dy * strength;
      this.updateCanvasPointPolar(other.point);
      moved.add(otherId);
    }
  }

  resolveCanvasNodeOverlapsAround(nodeId, iterations = 3) {
    if (!this.canvasData || !this.canvasData.nodesById.has(nodeId)) return;

    const dragged = this.canvasData.nodesById.get(nodeId);
    const rootId = this.lastCanvasBundle?.graph?.rootId;
    const zoom = clampFloat(this.state.zoom, this.canvasMinZoom(), this.canvasMaxZoom(), 1);
    const gap = Math.max(8, 14 / zoom);

    for (let pass = 0; pass < iterations; pass += 1) {
      for (const other of this.canvasData.nodes) {
        if (!other || other.node.id === nodeId) continue;

        let dx = other.point.x - dragged.point.x;
        let dy = other.point.y - dragged.point.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          const angle = deterministicPairAngle(nodeId, other.node.id);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const minDistance = dragged.radius + other.radius + gap;
        if (distance >= minDistance) continue;

        const push = (minDistance - distance) * (pass === 0 ? 0.95 : 0.72);
        const nx = dx / distance;
        const ny = dy / distance;
        const otherFixed = other.node.id === rootId;
        if (otherFixed) {
          dragged.point.x -= nx * push;
          dragged.point.y -= ny * push;
          this.updateCanvasPointPolar(dragged.point);
        } else {
          other.point.x += nx * push;
          other.point.y += ny * push;
          this.updateCanvasPointPolar(other.point);
        }
      }
    }
  }

  startCanvasSpringBack(nodeId) {
    this.cancelCanvasSpringBack();
    if (!this.canvasData || !this.canvasData.nodes || !this.canvasData.nodes.length) return;

    const rootId = this.lastCanvasBundle?.graph?.rootId;
    const items = [];
    let maxDistance = 0;

    for (const item of this.canvasData.nodes) {
      if (!item || !item.point || item.node.id === rootId) continue;
      const point = item.point;
      const homeX = Number.isFinite(point.homeX) ? point.homeX : point.x;
      const homeY = Number.isFinite(point.homeY) ? point.homeY : point.y;
      const distance = Math.hypot(point.x - homeX, point.y - homeY);
      if (distance < 0.55) continue;
      maxDistance = Math.max(maxDistance, distance);
      items.push({
        item,
        startX: point.x,
        startY: point.y,
        homeX,
        homeY,
        primary: item.node.id === nodeId
      });
    }

    if (!items.length) {
      this.requestCanvasDraw("full");
      return;
    }

    const started = performance.now();
    const duration = clampFloat(300 + Math.sqrt(maxDistance) * 16, 340, 760, 460);
    this.canvasSpringState = { items, started, duration };

    const tick = now => {
      const state = this.canvasSpringState;
      if (!state || this.dragState) {
        this.canvasSpringAnimationFrame = null;
        return;
      }

      const progress = clampFloat((now - state.started) / state.duration, 0, 1, 1);
      const eased = springBackEase(progress);

      for (const entry of state.items) {
        const point = entry.item.point;
        const strength = entry.primary ? eased : Math.min(1, eased * 0.94);
        point.x = entry.startX + (entry.homeX - entry.startX) * strength;
        point.y = entry.startY + (entry.homeY - entry.startY) * strength;
        this.updateCanvasPointPolar(point);
      }

      if (progress >= 1) {
        for (const entry of state.items) {
          const point = entry.item.point;
          point.x = entry.homeX;
          point.y = entry.homeY;
          this.updateCanvasPointPolar(point);
        }
        this.canvasSpringAnimationFrame = null;
        this.canvasSpringState = null;
        this.requestCanvasDraw("full");
        return;
      }

      this.canvasInteractionUntil = performance.now() + 120;
      this.drawCanvasGraph({ mode: "interactive" });
      this.canvasSpringAnimationFrame = window.requestAnimationFrame(tick);
    };

    this.canvasSpringAnimationFrame = window.requestAnimationFrame(tick);
  }

  cancelCanvasSpringBack() {
    if (this.canvasSpringAnimationFrame) {
      window.cancelAnimationFrame(this.canvasSpringAnimationFrame);
      this.canvasSpringAnimationFrame = null;
    }
    this.canvasSpringState = null;
  }

  canvasEventPoint(evt) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top
    };
  }

  screenToWorld(point) {
    const viewport = this.canvasViewport();
    const zoom = clampFloat(this.state.zoom, this.canvasMinZoom(viewport), this.canvasMaxZoom(viewport), 1);
    return {
      x: (point.x - this.canvasPanX) / zoom,
      y: (point.y - this.canvasPanY) / zoom
    };
  }

  zoomAtClientPoint(clientX, clientY, direction) {
    const point = this.canvas ? this.canvasEventPoint({ clientX, clientY }) : null;
    const viewport = this.canvasViewport();
    const minZoom = this.canvasMinZoom(viewport);
    const maxZoom = this.canvasMaxZoom(viewport);
    const previousZoom = clampFloat(this.state.zoom, minZoom, maxZoom, 1);
    const factor = Math.pow(ZOOM_WHEEL_STEP, direction > 0 ? 1 : -1);
    this.setCanvasZoom(previousZoom * factor, point, true);
  }

  syncZoomControls() {
    const viewport = this.canvasViewport();
    const minZoom = this.canvasMinZoom(viewport);
    const maxZoom = this.canvasMaxZoom(viewport);
    this.state.zoom = clampFloat(this.state.zoom, minZoom, maxZoom, 1);
    if (this.zoomInput) {
      this.zoomInput.min = "0";
      this.zoomInput.max = String(ZOOM_SLIDER_STEPS);
      this.zoomInput.value = zoomToSliderValue(this.state.zoom, minZoom, maxZoom);
    }
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.state.zoom * 100)}%`;
  }

  setCanvasZoom(nextZoom, anchorPoint = null, redraw = true) {
    const viewport = this.canvasViewport();
    const minZoom = this.canvasMinZoom(viewport);
    const maxZoom = this.canvasMaxZoom(viewport);
    const previousZoom = clampFloat(this.state.zoom, minZoom, maxZoom, 1);
    const zoom = clampFloat(nextZoom, minZoom, maxZoom, previousZoom);
    if (Math.abs(zoom - previousZoom) < 0.0001) {
      this.syncZoomControls();
      return;
    }

    const point = anchorPoint || { x: viewport.width / 2, y: viewport.height / 2 };
    if (this.canvas && this.lastCanvasBundle) {
      const world = {
        x: (point.x - this.canvasPanX) / previousZoom,
        y: (point.y - this.canvasPanY) / previousZoom
      };
      this.canvasPanX = point.x - world.x * zoom;
      this.canvasPanY = point.y - world.y * zoom;
    }

    this.state.zoom = zoom;
    this.syncZoomControls();
    this.saveViewportState();
    if (redraw && this.canvas && this.lastCanvasBundle) {
      this.requestCanvasDraw("interactive");
      this.scheduleSettledCanvasDraw();
    }
    else if (redraw) this.render();
  }

  updateCanvasHover(point) {
    const hit = this.hitTestCanvas(point, { includeLinks: hoverHighlightsNoteLinks(this.state.hoverHighlightMode) });
    const nextNodeId = hit.node ? hit.node.node.id : null;
    const nextLink = hit.link ? hit.link.edge : null;
    const sameLink = (!nextLink && !this.hoverLink) || (nextLink && this.hoverLink && nextLink.id === this.hoverLink.id);
    if (nextNodeId === this.hoverNodeId && sameLink) return;

    const hasNodeHover = nextNodeId !== null && nextNodeId !== undefined;
    this.hoverNodeId = nextNodeId;
    this.hoverLink = hasNodeHover ? null : nextLink;
    this.graphHost.classList.toggle("is-hovering", hasNodeHover || Boolean(this.hoverLink));
    this.graphHost.classList.toggle("is-pointing", hasNodeHover || Boolean(this.hoverLink));
    if (this.canvasNeedsFastDraw()) {
      this.requestCanvasDraw("interactive");
      this.scheduleSettledCanvasDraw(180);
    } else {
      this.requestCanvasDraw("full");
    }
  }

  activateCanvasAt(point, evt) {
    const { index, graph } = this.lastCanvasBundle || {};
    if (!index || !graph) return;
    const hit = this.hitTestCanvas(point, { includeLinks: true });

    if (hit.node) {
      evt.preventDefault();
      evt.stopPropagation();
      this.state.sidePage = "inspect";
      this.selectedLink = null;
      this.selectedNodeId = hit.node.node.id;
      this.applyPersistentHighlight();
      if (!this.state.fullscreen) this.renderSidePanel(index, graph, hit.node.node.id);
      return;
    }

    if (hit.link) {
      evt.preventDefault();
      evt.stopPropagation();
      this.state.sidePage = "inspect";
      this.selectedLink = hit.link.edge;
      this.selectedNodeId = null;
      this.applyPersistentHighlight();
      if (!this.state.fullscreen) this.renderSidePanel(index, graph);
      return;
    }

    this.clearSelection(index, graph);
  }

  hitTestCanvas(point, options = {}) {
    if (!this.canvasData) return { node: null, link: null };
    const world = this.screenToWorld(point);
    const viewport = this.canvasViewport();
    const zoom = clampFloat(this.state.zoom, this.canvasMinZoom(viewport), this.canvasMaxZoom(viewport), 1);
    const nodePad = Math.max(4, 8 / zoom);
    const hitNode = this.canvasSwirlMotionActive()
      ? hitTestCanvasNodeLinear(this.canvasData, world, nodePad)
      : hitTestCanvasNodeIndex(this.canvasData, world, nodePad);
    if (hitNode) return { node: hitNode, link: null };

    if (options.includeLinks) {
      const linkPad = Math.max(4, 7 / zoom);
      for (let i = this.canvasData.links.length - 1; i >= 0; i -= 1) {
        const item = this.canvasData.links[i];
        const distance = distanceToSegment(world, item.sourcePoint, item.targetPoint);
        if (distance <= linkPad + item.width * 0.5) return { node: null, link: item };
      }
    }

    return { node: null, link: null };
  }

  drawCanvasGraph(options = {}) {
    if (!this.canvas || !this.canvasData || !this.lastCanvasBundle) return;
    const viewport = this.canvasViewport();
    this.sizeCanvasToViewport(this.canvas, viewport);

    const ctx = this.canvas.getContext("2d");
    const palette = this.canvasPalette || this.readCanvasPalette();
    const zoom = clampFloat(this.state.zoom, this.canvasMinZoom(viewport), this.canvasMaxZoom(viewport), 1);
    const frameTime = Number.isFinite(options.now) ? options.now : performance.now();
    this.applyCanvasSwirlFrame(frameTime);
    const active = this.canvasActiveState();
    const mode = options.mode || (this.dragState || performance.now() < this.canvasInteractionUntil ? "interactive" : "full");
    const interactive = mode === "interactive";
    const fastInteractive = interactive && this.canvasNeedsFastDraw();
    const visuals = this.updateCanvasVisualState(active, zoom, { immediate: interactive });
    const bounds = canvasWorldBounds(viewport, this.canvasPanX, this.canvasPanY, zoom, interactive ? 120 : 220);
    const highlightedHoverLinks = active.highlightedEdges.size
      ? Array.from(active.highlightedEdges)
        .map(key => this.canvasData.edgesById.get(key))
        .filter(item => item && item.hoverOnly)
      : [];
    this.updateCanvasDynamicLinkRoutes({
      enabled: this.canvasSwirlMotionActive(),
      includeBaseLinks: !fastInteractive,
      highlightedHoverLinks
    });

    ctx.setTransform(this.canvasDpr, 0, 0, this.canvasDpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    this.drawCanvasBackground(ctx, palette, viewport);

    ctx.save();
    ctx.translate(this.canvasPanX, this.canvasPanY);
    ctx.scale(zoom, zoom);
    this.drawCanvasRings(ctx, this.lastCanvasBundle.layout, palette, zoom, { underlay: true, interactive, now: frameTime });
    if (!fastInteractive) {
      this.drawCanvasEdges(ctx, this.canvasData.links, visuals, palette, zoom, false, { bounds, interactive });
    }
    this.drawCanvasEdges(ctx, this.canvasData.hierarchy, visuals, palette, zoom, true, { bounds, interactive });
    if (!interactive) this.drawCanvasRings(ctx, this.lastCanvasBundle.layout, palette, zoom, { overlay: true, now: frameTime });
    this.drawCanvasEdges(ctx, highlightedHoverLinks, visuals, palette, zoom, false, { hoverOnly: true, bounds, interactive });
    this.drawCanvasNodes(ctx, this.canvasData.nodes, visuals, palette, zoom, { bounds, interactive });
    this.drawCanvasLabels(ctx, this.canvasData.nodes, visuals, palette, zoom, { bounds, interactive, fastInteractive });
    ctx.restore();
  }

  canvasNeedsFastDraw() {
    if (!this.canvasData) return false;
    const edgeCount = (this.canvasData.links?.length || 0) + (this.canvasData.hierarchy?.length || 0);
    return this.state.showCompleteRoot
      || (this.canvasData.nodes?.length || 0) > FAST_CANVAS_NODE_THRESHOLD
      || edgeCount > FAST_CANVAS_EDGE_THRESHOLD;
  }

  canvasSwirlAmount() {
    return clampFloat(
      clampNumber(this.state.swirlStrength, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH) / MAX_SWIRL_STRENGTH,
      0,
      1,
      0
    );
  }

  canvasSwirlMotionActive() {
    return this.canvasSwirlAmount() > 0.001;
  }

  setSpinSpeed(value, options = {}) {
    const previous = this.state.swirlStrength;
    const next = clampNumber(value, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH);
    this.state.swirlStrength = next;

    if (this.canvas && this.canvasData) {
      if (next > 0) {
        this.startCanvasSwirlAnimation();
        this.requestCanvasDraw("interactive");
      } else {
        this.cancelCanvasSwirlAnimation();
        this.resetCanvasSwirlPositions();
        this.requestCanvasDraw("full");
      }
    }

    const crossedZero = (previous > 0) !== (next > 0);
    if (options.render || crossedZero) this.scheduleRender(options.render ? 0 : 140);
  }

  startCanvasSwirlAnimation() {
    this.cancelCanvasSwirlAnimation(false);
    if (!this.canvas || !this.canvasData || !this.canvasSwirlMotionActive()) {
      this.resetCanvasSwirlPositions();
      return;
    }

    if (!this.canvasSwirlStartedAt) this.canvasSwirlStartedAt = performance.now();
    this.canvasSwirlLastFrameAt = 0;

    const tick = now => {
      this.canvasSwirlAnimationFrame = null;
      if (!this.canvas || !this.canvasData || !this.canvasSwirlMotionActive()) {
        this.resetCanvasSwirlPositions();
        return;
      }

      const frameInterval = this.canvasNeedsFastDraw()
        ? SWIRL_FRAME_INTERVAL_MS * 1.75
        : SWIRL_FRAME_INTERVAL_MS;
      if (!this.canvasSwirlLastFrameAt || now - this.canvasSwirlLastFrameAt >= frameInterval) {
        this.canvasSwirlLastFrameAt = now;
        this.canvasInteractionUntil = Math.max(this.canvasInteractionUntil, performance.now() + 80);
        this.drawCanvasGraph({ mode: "spin", now });
      }

      this.canvasSwirlAnimationFrame = window.requestAnimationFrame(tick);
    };

    this.canvasSwirlAnimationFrame = window.requestAnimationFrame(tick);
  }

  cancelCanvasSwirlAnimation(reset = true) {
    if (this.canvasSwirlAnimationFrame) {
      window.cancelAnimationFrame(this.canvasSwirlAnimationFrame);
      this.canvasSwirlAnimationFrame = null;
    }
    this.canvasSwirlLastFrameAt = 0;
    if (reset) this.canvasSwirlStartedAt = 0;
  }

  applyCanvasSwirlFrame(now = performance.now()) {
    if (!this.canvasData || !this.canvasData.nodes || !this.canvasData.nodes.length) return;
    const amount = this.canvasSwirlAmount();
    if (amount <= 0.001 || this.dragState || this.canvasSpringState) {
      if (amount <= 0.001) this.resetCanvasSwirlPositions();
      return;
    }

    if (!this.canvasSwirlStartedAt) this.canvasSwirlStartedAt = now;
    const elapsedSeconds = Math.max(0, (now - this.canvasSwirlStartedAt) / 1000);

    for (const item of this.canvasData.nodes) {
      if (!item || !item.point) continue;
      const point = item.point;
      const radius = Number.isFinite(point.homeRadius) ? point.homeRadius : point.radius;
      if (!Number.isFinite(radius) || radius <= 0.001) continue;

      const depth = Math.max(0, Math.round(point.depth || 0));
      if (depth === 0) {
        point.x = Number.isFinite(point.homeX) ? point.homeX : point.x;
        point.y = Number.isFinite(point.homeY) ? point.homeY : point.y;
        this.updateCanvasPointPolar(point);
        continue;
      }

      const centerX = Number.isFinite(point.centerX) ? point.centerX : 0;
      const centerY = Number.isFinite(point.centerY) ? point.centerY : 0;
      const homeAngle = Number.isFinite(point.homeAngle) ? point.homeAngle : point.angle;
      const offset = swirlOrbitAngleForRing(depth, radius, amount, elapsedSeconds);
      const angle = normalizeAngle(homeAngle + offset);
      point.x = centerX + Math.cos(angle) * radius;
      point.y = centerY + Math.sin(angle) * radius;
      point.radius = radius;
      point.angle = angle;
      point.labelSide = labelSideForAngle(angle);
    }
  }

  resetCanvasSwirlPositions() {
    if (!this.canvasData || !this.canvasData.nodes) return;
    for (const item of this.canvasData.nodes) {
      const point = item?.point;
      if (!point || !Number.isFinite(point.homeX) || !Number.isFinite(point.homeY)) continue;
      point.x = point.homeX;
      point.y = point.homeY;
      if (Number.isFinite(point.homeRadius)) point.radius = point.homeRadius;
      if (Number.isFinite(point.homeAngle)) point.angle = point.homeAngle;
      point.labelSide = labelSideForAngle(point.angle);
    }
  }

  updateCanvasDynamicLinkRoutes(options = {}) {
    if (!this.canvasData) return;
    const enabled = Boolean(options.enabled);
    const highlightedHoverLinks = Array.isArray(options.highlightedHoverLinks) ? options.highlightedHoverLinks : [];
    const items = [];

    if (options.includeBaseLinks !== false) items.push(...(this.canvasData.links || []));
    items.push(...highlightedHoverLinks);

    if (!enabled || !items.length) {
      for (const item of items) {
        if (item) item.dynamicRoute = null;
      }
      return;
    }

    const layout = this.lastCanvasBundle?.layout;
    const ringGap = medianRingGap(layout?.rings || []);
    const centerX = Number.isFinite(layout?.centerX) ? layout.centerX : 0;
    const centerY = Number.isFinite(layout?.centerY) ? layout.centerY : 0;
    const capped = items.length > MAX_DYNAMIC_ROUTE_EDGES
      ? items.slice(0, MAX_DYNAMIC_ROUTE_EDGES)
      : items;

    for (const item of capped) {
      if (!item || !item.sourcePoint || !item.targetPoint) continue;
      item.dynamicRoute = dynamicOrbitRouteForEdge(item, centerX, centerY, ringGap);
    }

    if (capped.length < items.length) {
      for (let index = capped.length; index < items.length; index += 1) {
        if (items[index]) items[index].dynamicRoute = null;
      }
    }
  }

  drawCanvasBackground(ctx, palette, viewport) {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }

  canvasActiveState() {
    const data = this.canvasData;
    const rawActiveNodeId = this.hoverNodeId ?? this.selectedNodeId ?? null;
    const hoverMode = normalizeHoverHighlightMode(this.state.hoverHighlightMode);
    let activeNodeId = this.plugin.index.visualNodeId(rawActiveNodeId);
    let activeLinkId = this.hoverLink?.id || this.selectedLink?.id || null;
    if (activeNodeId !== null && activeNodeId !== undefined && !data.nodesById.has(activeNodeId)) activeNodeId = null;
    if (activeLinkId && !data.edgesById.has(activeLinkId)) activeLinkId = null;
    const relatedNodes = new Set();
    const highlightedEdges = new Set();
    const labelNodes = new Set();

    if (activeNodeId !== null && activeNodeId !== undefined) {
      relatedNodes.add(activeNodeId);
      labelNodes.add(activeNodeId);
      if (hoverHighlightsNoteLinks(hoverMode)) {
        for (const edge of data.linkEdgesByNode.get(activeNodeId) || []) {
          highlightedEdges.add(edge.key);
          if (edge.source !== null && edge.source !== undefined) relatedNodes.add(edge.source);
          if (edge.target !== null && edge.target !== undefined) relatedNodes.add(edge.target);
        }
      }
      addHierarchyHoverHighlights(data, activeNodeId, hoverMode, relatedNodes, highlightedEdges, labelNodes);
    }

    if (activeLinkId) {
      const edge = data.edgesById.get(activeLinkId);
      if (edge) {
        highlightedEdges.add(edge.key);
        relatedNodes.add(edge.source);
        relatedNodes.add(edge.target);
        labelNodes.add(edge.source);
        labelNodes.add(edge.target);
      }
    }

    for (const node of data.searchMatchItems || []) {
      if (node.searchMatch) labelNodes.add(node.node.id);
    }

    return {
      hasActive: activeNodeId !== null && activeNodeId !== undefined || Boolean(activeLinkId),
      activeNodeId,
      activeLinkId,
      relatedNodes,
      highlightedEdges,
      labelNodes
    };
  }

  updateCanvasVisualState(active, zoom = 1, options = {}) {
    const now = performance.now();
    const delta = this.lastCanvasFrameAt ? Math.min(80, now - this.lastCanvasFrameAt) : 16;
    this.lastCanvasFrameAt = now;
    const immediate = Boolean(options.immediate);
    const step = immediate
      ? 1
      : this.canvasVisualInitialized
        ? clampFloat(delta / 72, 0.16, 0.86, 0.32)
        : 1;
    let needsFrame = false;

    const updateValue = (current, target) => {
      if (!this.canvasVisualInitialized) return target;
      const next = current + (target - current) * step;
      if (!immediate && Math.abs(next - target) > 0.012) needsFrame = true;
      return Math.abs(next - target) < 0.006 ? target : next;
    };

    const currentNodeIds = new Set();
    const hoverOnlyLabels = normalizeLabelVisibility(this.state.labelVisibility) === "hover";
    for (const item of this.canvasData.nodes) {
      const nodeId = item.node.id;
      currentNodeIds.add(nodeId);
      const isFocused = nodeId === active.activeNodeId
        || nodeId === this.selectedNodeId
        || nodeId === this.lastCanvasBundle.graph.focusId
        || item.searchMatch;
      const isRelated = active.relatedNodes.has(nodeId);
      const directLabel = nodeId === active.activeNodeId
        || nodeId === this.selectedNodeId
        || item.searchMatch;
      const explicitLabel = directLabel || (!hoverOnlyLabels && active.labelNodes.has(nodeId));
      const target = {
        focus: isFocused ? 1 : 0,
        related: active.hasActive && isRelated && !isFocused ? 1 : 0,
        dim: active.hasActive && !isRelated && !isFocused ? 1 : 0,
        label: hoverOnlyLabels
          ? (explicitLabel ? 1 : 0)
          : Math.max(active.labelNodes.has(nodeId) ? 1 : 0, zoomLabelStrength(item, zoom, this.lastCanvasBundle.graph))
      };
      const current = this.canvasVisualNodes.get(nodeId) || { focus: 0, related: 0, dim: 0, label: 0 };
      this.canvasVisualNodes.set(nodeId, {
        focus: updateValue(current.focus, target.focus),
        related: updateValue(current.related, target.related),
        dim: updateValue(current.dim, target.dim),
        label: updateValue(current.label, target.label)
      });
    }

    for (const id of Array.from(this.canvasVisualNodes.keys())) {
      if (!currentNodeIds.has(id)) this.canvasVisualNodes.delete(id);
    }

    const visibleHoverLinks = active.highlightedEdges.size
      ? Array.from(active.highlightedEdges)
        .map(key => this.canvasData.edgesById.get(key))
        .filter(item => item && item.hoverOnly)
      : [];
    const currentEdgeKeys = new Set();
    const updateEdge = item => {
      if (!item) return;
      currentEdgeKeys.add(item.key);
      const target = {
        highlight: active.highlightedEdges.has(item.key) ? 1 : 0,
        dim: active.hasActive && !active.highlightedEdges.has(item.key) ? 1 : 0
      };
      const current = this.canvasVisualEdges.get(item.key) || { highlight: 0, dim: 0 };
      this.canvasVisualEdges.set(item.key, {
        highlight: updateValue(current.highlight, target.highlight),
        dim: updateValue(current.dim, target.dim)
      });
    };
    for (const item of this.canvasData.hierarchy) updateEdge(item);
    for (const item of this.canvasData.links) updateEdge(item);
    for (const item of visibleHoverLinks) updateEdge(item);

    for (const key of Array.from(this.canvasVisualEdges.keys())) {
      if (!currentEdgeKeys.has(key)) this.canvasVisualEdges.delete(key);
    }

    this.canvasVisualInitialized = true;
    if (needsFrame) this.scheduleCanvasAnimation();

    return {
      nodes: this.canvasVisualNodes,
      edges: this.canvasVisualEdges
    };
  }

  scheduleCanvasAnimation() {
    this.requestCanvasDraw("full");
  }

  requestCanvasDraw(mode = "full") {
    if (mode === "interactive") {
      this.canvasInteractionUntil = performance.now() + 120;
    }

    if (this.canvasAnimationFrame) {
      this.nextCanvasDrawMode = mode === "full" ? "full" : "interactive";
      return;
    }

    this.nextCanvasDrawMode = mode;
    this.canvasAnimationFrame = window.requestAnimationFrame(() => {
      const drawMode = this.nextCanvasDrawMode || "full";
      this.canvasAnimationFrame = null;
      this.nextCanvasDrawMode = "full";
      this.drawCanvasGraph({ mode: drawMode });
    });
  }

  scheduleSettledCanvasDraw(delay = 140) {
    if (this.canvasSettleTimer) window.clearTimeout(this.canvasSettleTimer);
    this.canvasSettleTimer = window.setTimeout(() => {
      this.canvasSettleTimer = null;
      this.requestCanvasDraw("full");
    }, delay);
  }

  drawCanvasRings(ctx, layout, palette, zoom, options = {}) {
    if (!layout || !Array.isArray(layout.rings) || !layout.rings.length) return;
    const centerX = Number.isFinite(layout.centerX) ? layout.centerX : layout.width / 2;
    const centerY = Number.isFinite(layout.centerY) ? layout.centerY : layout.height / 2;
    const alphaScale = options.overlay ? 1.16 : options.underlay ? 0.58 : 1;
    const swirlStrength = clampFloat(layout.swirlStrength, 0, 1, 0);
    const spinSpeed = this.canvasSwirlAmount();
    const elapsedSeconds = this.canvasSwirlStartedAt && Number.isFinite(options.now)
      ? Math.max(0, (options.now - this.canvasSwirlStartedAt) / 1000)
      : 0;

    ctx.save();
    ctx.strokeStyle = palette.ringGuide || palette.folderRing || palette.line;

    for (const ring of layout.rings) {
      if (!Number.isFinite(ring.radius) || ring.radius <= 0) continue;
      const density = Math.min(1, Math.sqrt(Math.max(1, ring.count || 1)) / 9);
      const ringPhase = swirlOrbitAngleForRing(ring.depth, ring.radius, spinSpeed, elapsedSeconds);
      if (options.overlay) {
        ctx.setLineDash([]);
        ctx.globalAlpha = (0.035 + density * 0.025) * alphaScale;
        ctx.lineWidth = Math.max(4.5 / zoom, 6.5 / zoom);
        ctx.beginPath();
        drawCanvasRingPath(ctx, centerX, centerY, ring.radius, ring.depth, swirlStrength, ringPhase);
        ctx.stroke();
      }

      ctx.setLineDash([options.overlay ? 5 / zoom : 3 / zoom, options.overlay ? 6 / zoom : 11 / zoom]);
      ctx.globalAlpha = (0.13 + density * 0.09) * alphaScale;
      ctx.lineWidth = Math.max((options.overlay ? 1.05 : 0.55) / zoom, (options.overlay ? 1.55 : 0.86) / zoom);
      ctx.beginPath();
      drawCanvasRingPath(ctx, centerX, centerY, ring.radius, ring.depth, swirlStrength, ringPhase);
      ctx.stroke();
    }

    ctx.restore();
  }

  drawCanvasEdges(ctx, edges, visuals, palette, zoom, hierarchy, options = {}) {
    const hoverOnly = Boolean(options.hoverOnly);
    const bounds = options.bounds || null;
    const interactive = Boolean(options.interactive);
    for (const item of edges) {
      if (bounds && !edgeItemInBounds(item, bounds)) continue;
      const visual = visuals.edges.get(item.key) || { highlight: 0, dim: 0 };
      if (hoverOnly && visual.highlight <= 0.01) continue;
      const unresolved = item.edge && item.edge.unresolvedCount;
      const external = item.external || (item.edge && item.edge.externalCount);
      const externalHierarchy = hierarchy && external;
      const outsideLink = !hierarchy && external;
      const color = unresolved
          ? palette.unresolved
          : outsideLink
            ? (palette.externalLink || palette.external)
            : hierarchy
              ? (palette.tree || palette.folderRing || palette.line)
              : palette.link;
      const spinLinkFade = !hierarchy && !hoverOnly && this.canvasSwirlMotionActive() ? 0.58 : 1;
      const baseAlpha = (hierarchy
        ? (externalHierarchy ? 0.18 : 0.34)
        : (outsideLink ? 0.082 : 0.056)) * spinLinkFade;
      const minAlpha = (hierarchy ? 0.09 : outsideLink ? 0.03 : 0.024) * spinLinkFade;
      const dimFade = hierarchy ? 0.48 : 0.58;
      const width = hierarchy
        ? (externalHierarchy ? 1.12 : 1.48)
        : (outsideLink ? item.width * 0.72 : item.width * 0.7);
      const applyDash = () => {
        ctx.setLineDash([]);
        if (unresolved) ctx.setLineDash([7 / zoom, 5 / zoom]);
        else if (outsideLink) ctx.setLineDash([8 / zoom, 7 / zoom]);
        else if (externalHierarchy) ctx.setLineDash([2.5 / zoom, 5 / zoom]);
      };

      ctx.save();
      if (!hoverOnly) {
        ctx.globalAlpha = Math.max(minAlpha, baseAlpha * (1 - visual.dim * dimFade));
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max((outsideLink ? 0.58 : 0.45) / zoom, width / zoom);
        ctx.lineCap = "round";
        if (!interactive || outsideLink || unresolved) applyDash();
        else ctx.setLineDash([]);
        ctx.beginPath();
        this.drawCanvasEdgePath(ctx, item);
        ctx.stroke();
      }
      if (visual.highlight > 0.01) {
        applyDash();
        ctx.globalAlpha = visual.highlight * (hierarchy ? 0.78 : outsideLink ? 0.76 : hoverOnly ? 0.74 : 0.88);
        ctx.strokeStyle = outsideLink ? (palette.externalLink || palette.external) : (palette.lineHighlight || palette.focus);
        ctx.lineWidth = Math.max(0.7 / zoom, (hierarchy ? 2.2 : outsideLink ? 2.1 : hoverOnly ? 1.9 : 2.35) / zoom);
        ctx.shadowColor = outsideLink ? (palette.externalLink || palette.external) : palette.glow;
        ctx.shadowBlur = (outsideLink ? 6 : 8) / zoom;
        ctx.beginPath();
        this.drawCanvasEdgePath(ctx, item);
        ctx.stroke();
        if (!hierarchy && this.canvasData?.showArrow) {
          this.drawCanvasArrow(ctx, item, zoom, outsideLink ? (palette.externalLink || palette.external) : (palette.lineHighlight || palette.focus));
        }
      }
      ctx.restore();
    }
  }

  drawCanvasEdgePath(ctx, item) {
    const source = item.sourcePoint;
    const target = item.targetPoint;
    const route = item.dynamicRoute || item.route;

    ctx.moveTo(source.x, source.y);

    if (route && (route.kind === "outer" || route.kind === "external" || route.kind === "dynamic-orbit")) {
      const startAngle = route.sourceAngle;
      const endAngle = Number.isFinite(route.endAngle) ? route.endAngle : route.targetAngle;
      const arcStart = radialPoint(route.centerX, route.centerY, route.radius, startAngle);
      const arcEnd = radialPoint(route.centerX, route.centerY, route.radius, endAngle);
      ctx.lineTo(arcStart.x, arcStart.y);
      ctx.arc(route.centerX, route.centerY, route.radius, startAngle, endAngle, endAngle < startAngle);
      ctx.lineTo(arcEnd.x, arcEnd.y);
      ctx.lineTo(target.x, target.y);
      return;
    }

    if (route && route.kind === "curve") {
      const centerX = Number.isFinite(source.centerX) ? source.centerX : (source.x + target.x) / 2;
      const centerY = Number.isFinite(source.centerY) ? source.centerY : (source.y + target.y) / 2;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const pull = Number.isFinite(route.curveStrength) ? route.curveStrength : (item.external ? 0.28 : 0.16);
      ctx.quadraticCurveTo(
        midX + (centerX - midX) * pull,
        midY + (centerY - midY) * pull,
        target.x,
        target.y
      );
      return;
    }

    ctx.lineTo(target.x, target.y);
  }

  drawCanvasArrow(ctx, item, zoom, color) {
    const source = this.canvasArrowSourcePoint(item);
    const target = item.targetPoint;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;

    const targetNode = this.canvasData?.nodesById?.get(item.target);
    const targetRadius = targetNode ? targetNode.radius : 6;
    const angle = Math.atan2(dy, dx);
    const tipOffset = targetRadius + 2 / zoom;
    const tipX = target.x - Math.cos(angle) * tipOffset;
    const tipY = target.y - Math.sin(angle) * tipOffset;
    const size = 7 / zoom;
    const spread = 0.48;

    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - Math.cos(angle - spread) * size,
      tipY - Math.sin(angle - spread) * size
    );
    ctx.lineTo(
      tipX - Math.cos(angle + spread) * size,
      tipY - Math.sin(angle + spread) * size
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  canvasArrowSourcePoint(item) {
    const route = item.dynamicRoute || item.route;
    if (route && (route.kind === "outer" || route.kind === "external" || route.kind === "dynamic-orbit")) {
      const endAngle = Number.isFinite(route.endAngle) ? route.endAngle : route.targetAngle;
      return radialPoint(route.centerX, route.centerY, route.radius, endAngle);
    }

    if (route && route.kind === "curve") {
      const source = item.sourcePoint;
      const target = item.targetPoint;
      const centerX = Number.isFinite(source.centerX) ? source.centerX : (source.x + target.x) / 2;
      const centerY = Number.isFinite(source.centerY) ? source.centerY : (source.y + target.y) / 2;
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      const pull = Number.isFinite(route.curveStrength) ? route.curveStrength : (item.external ? 0.28 : 0.16);
      return {
        x: midX + (centerX - midX) * pull,
        y: midY + (centerY - midY) * pull
      };
    }

    return item.sourcePoint;
  }

  drawCanvasNodes(ctx, nodes, visuals, palette, zoom, options = {}) {
    const bounds = options.bounds || null;
    for (const item of nodes) {
      if (bounds && !circleInBounds(item.point, item.radius + 6 / zoom, bounds)) continue;
      const nodeId = item.node.id;
      const visual = visuals.nodes.get(nodeId) || { focus: 0, related: 0, dim: 0, label: 0 };
      const rootNode = nodeId === this.lastCanvasBundle.graph.rootId;
      const folderNode = item.node.type === "folder";
      const folderWithMeta = folderNode && Boolean(item.node.representativeFile);
      const externalGroup = item.node.type === "external" && !item.node.externalProxy;
      const externalFile = Boolean(item.node.externalProxy);
      const unresolvedNode = item.node.type === "unresolved";
      const alpha = clampFloat(0.9 - visual.dim * 0.58 + visual.related * 0.1, 0.24, 1, 0.9);
      const fill = unresolvedNode
        ? palette.unresolved
        : externalGroup
          ? palette.node
          : folderWithMeta
            ? palette.folderMeta
            : folderNode
              ? palette.folder
            : (palette.note || palette.node);
      const stroke = rootNode
        ? palette.circle
        : unresolvedNode
          ? palette.unresolved
        : externalGroup || externalFile
          ? palette.external
          : folderNode
            ? palette.folderRing
            : palette.fileRing || palette.stroke;

      ctx.save();
      ctx.globalAlpha = externalGroup ? alpha * 0.82 : alpha;
      ctx.shadowColor = palette.glow;
      ctx.shadowBlur = (visual.focus * 13 + (rootNode ? 3 : 0)) / zoom;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(item.point.x, item.point.y, item.radius, 0, Math.PI * 2);
      ctx.fill();
      if (visual.focus > 0.01) {
        ctx.globalAlpha = visual.focus * 0.96;
        ctx.fillStyle = palette.focus;
        ctx.beginPath();
        ctx.arc(item.point.x, item.point.y, item.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = clampFloat(alpha + visual.focus * 0.28, 0.12, 1, alpha);
      ctx.strokeStyle = visual.focus > 0.08 ? palette.circle : stroke;
      ctx.lineWidth = (0.85 + visual.focus * 1.35 + (rootNode ? 0.55 : folderNode ? 0.22 : 0)) / zoom;
      if (externalGroup || externalFile || unresolvedNode) ctx.setLineDash([3 / zoom, 4 / zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  drawCanvasLabels(ctx, nodes, visuals, palette, zoom, options = {}) {
    const fontSize = 12;
    const lineHeight = 14;
    const screenScale = labelScreenScale(zoom);
    const bounds = options.bounds || null;
    const interactive = Boolean(options.interactive);
    const fastInteractive = Boolean(options.fastInteractive);
    ctx.save();
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.lineJoin = "round";

    let labelItems = interactive
      ? (this.canvasData?.interactiveLabelItems || nodes)
      : (this.canvasData?.labelItems || nodes);
    if (interactive) {
      const extraIds = [this.selectedNodeId, this.hoverNodeId, this.lastCanvasBundle?.graph?.focusId]
        .filter(id => id !== null && id !== undefined);
      if (extraIds.length) {
        const seen = new Set(labelItems.map(item => item.node.id));
        const extras = extraIds
          .filter(id => !seen.has(id) && this.canvasData?.nodesById?.has(id))
          .map(id => this.canvasData.nodesById.get(id));
        if (extras.length) labelItems = labelItems.concat(extras);
      }
    }

    for (const item of labelItems) {
      if (bounds && !circleInBounds(item.point, item.radius + 180 / zoom, bounds)) continue;
      if (interactive && !item.searchMatch && item.labelRank > FAST_CANVAS_LABEL_LIMIT && item.node.id !== this.selectedNodeId && item.node.id !== this.hoverNodeId) continue;
      const visual = visuals.nodes.get(item.node.id) || { label: 0, focus: 0 };
      if (visual.label <= 0.02) continue;
      if (fastInteractive && visual.focus <= 0.02 && !item.searchMatch && item.labelRank > 36) continue;
      const rootNode = item.node.id === this.lastCanvasBundle.graph.rootId;
      const folderNode = item.node.type === "folder";
      const leading = Number.isFinite(item.labelRank) && item.labelRank < 36;
      const localScale = screenScale * (rootNode ? 1.18 : item.radius >= 24 ? 1.1 : item.radius >= 15 ? 1.04 : 1);
      const weight = rootNode || leading || folderNode ? 600 : 400;
      ctx.font = `${weight} ${(fontSize * localScale) / zoom}px ${palette.fontFamily}`;
      const maxWidth = ((rootNode ? 190 : folderNode ? 156 : leading ? 146 : 124) * localScale) / zoom;
      const maxLines = rootNode || visual.focus > 0.5 ? 4 : 3;
      const lines = wrapCanvasLabel(ctx, item.label, maxWidth, maxLines);
      if (!lines.length) continue;

      const x = item.point.x;
      const y = item.point.y + item.radius + (8 * localScale) / zoom;
      const lineHeightWorld = (lineHeight * localScale) / zoom;
      ctx.globalAlpha = visual.label * (rootNode ? 0.98 : leading ? 0.95 : 0.9);
      ctx.lineWidth = ((rootNode ? 6 : 5) * localScale) / zoom;
      ctx.strokeStyle = palette.labelStroke || palette.bg;
      for (let index = 0; index < lines.length; index += 1) {
        ctx.strokeText(lines[index], x, y + index * lineHeightWorld);
      }
      ctx.fillStyle = rootNode ? (palette.circle || palette.labelText || palette.text) : (palette.labelText || palette.text);
      for (let index = 0; index < lines.length; index += 1) {
        ctx.fillText(lines[index], x, y + index * lineHeightWorld);
      }
    }

    ctx.restore();
  }

  installPanelResize() {
    if (!this.splitter) return;
    this.splitter.addEventListener("mousedown", evt => {
      evt.preventDefault();
      const startX = evt.clientX;
      const startWidth = this.state.sidePanelWidth;
      this.bodyEl.classList.add("is-resizing");

      const onMove = moveEvt => {
        const delta = moveEvt.clientX - startX;
        this.state.sidePanelWidth = clampNumber(startWidth - delta, 220, 720, 360);
        this.bodyEl.style.setProperty("--mwm-side-width", `${this.state.sidePanelWidth}px`);
      };

      const onUp = () => {
        this.bodyEl.classList.remove("is-resizing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  adjustZoom(delta, rerender = true) {
    const viewport = this.canvasViewport();
    const minZoom = this.canvasMinZoom(viewport);
    const maxZoom = this.canvasMaxZoom(viewport);
    const previousZoom = clampFloat(this.state.zoom, minZoom, maxZoom, 1);
    this.state.zoom = clampFloat(previousZoom * Math.pow(ZOOM_BUTTON_STEP, delta), minZoom, maxZoom, 1);
    if (!rerender) return;
    if (this.canvas && this.lastCanvasBundle) {
      const center = { x: viewport.width / 2, y: viewport.height / 2 };
      const world = {
        x: (center.x - this.canvasPanX) / previousZoom,
        y: (center.y - this.canvasPanY) / previousZoom
      };
      this.canvasPanX = center.x - world.x * this.state.zoom;
      this.canvasPanY = center.y - world.y * this.state.zoom;
      this.syncZoomControls();
      this.requestCanvasDraw("interactive");
      this.scheduleSettledCanvasDraw();
      return;
    }
    this.render();
  }

  fitToView() {
    if (!this.lastLayout || !this.graphHost) return;
    const viewport = this.canvasViewport();
    this.state.zoom = clampFloat(
      fitZoomForLayout(this.lastLayout, viewport, 32),
      this.canvasMinZoom(viewport, this.lastLayout),
      this.canvasMaxZoom(viewport, this.lastLayout),
      1
    );
    if (this.canvas && this.lastCanvasBundle) {
      this.centerCanvasView(this.lastLayout, viewport, null);
      this.syncZoomControls();
      this.requestCanvasDraw("full");
      return;
    }
    this.render();
  }

  registerEdgeElement(element, edge) {
    if (!element || !edge) return;
    if (edge.id) this.edgeElementsById.set(edge.id, element);
    for (const id of [edge.source, edge.target]) {
      if (!id) continue;
      if (!this.edgeElementsByNode.has(id)) this.edgeElementsByNode.set(id, []);
      this.edgeElementsByNode.get(id).push(element);
    }
  }

  markHighlight(element, className) {
    if (!element) return;
    element.classList.add(className);
    this.activeHighlightElements.add(element);
  }

  setHoverNode(nodeId) {
    this.hoverNodeId = nodeId;
    this.hoverLink = null;
    if (this.graphHost) this.graphHost.classList.add("is-hovering");
    this.requestCanvasDraw("full");
  }

  highlightNode(nodeId) {
    this.setHoverNode(nodeId);
  }

  setHoverLink(edge, element) {
    this.hoverNodeId = null;
    this.hoverLink = edge || null;
    if (this.graphHost) this.graphHost.classList.toggle("is-hovering", Boolean(edge));
    this.requestCanvasDraw("full");
  }

  highlightLink(edge, element) {
    this.setHoverLink(edge);
  }

  clearHover() {
    this.clearHoverClasses();
    if (this.graphHost) this.graphHost.classList.remove("is-hovering");
    if (this.graphHost) this.graphHost.classList.remove("is-pointing");
    this.hoverNodeId = null;
    this.hoverLink = null;
    this.requestCanvasDraw("full");
  }

  clearHoverClasses() {
    for (const element of this.activeHighlightElements) {
      element.classList.remove("is-highlighted", "is-related", "is-hovered");
    }
    this.activeHighlightElements.clear();
  }

  findLinkElement(edge) {
    if (!edge) return null;
    return this.edgeElementsById.get(edge.id) || null;
  }

  applyPersistentHighlight() {
    if (!this.graphHost) return;
    this.clearHoverClasses();
    this.graphHost.classList.toggle(
      "is-hovering",
      this.hoverNodeId !== null && this.hoverNodeId !== undefined || Boolean(this.hoverLink)
    );
    this.requestCanvasDraw("full");
  }

  showNodeMenu(evt, node) {
    const menu = new Menu();
    if (node.type === "note") {
      menu.addItem(item => item
        .setTitle("Open note")
        .setIcon("file-text")
        .onClick(() => this.openNode(node.id, evt)));
      menu.addItem(item => item
        .setTitle("Focus note")
        .setIcon("locate-fixed")
        .onClick(() => {
          this.state.mode = "focus";
          this.state.focusPath = node.id;
          this.state.showCompleteRoot = false;
          this.viewInitialized = false;
          this.resetAdaptiveTuning();
          this.render();
        }));
    }
    if (node.type === "folder") {
      menu.addItem(item => item
        .setTitle("Use as atlas root")
        .setIcon("folder-open")
        .onClick(() => {
          this.state.mode = "atlas";
          this.state.rootPath = node.id;
          this.state.showCompleteRoot = false;
          this.viewInitialized = false;
          this.resetAdaptiveTuning();
          this.render();
        }));
      if (node.representativeFile) {
        menu.addItem(item => item
          .setTitle("Open representative note")
          .setIcon("file-text")
          .onClick(() => this.openNode(node.representativeFile, evt)));
      }
    }
    menu.showAtMouseEvent(evt);
  }

  renderSidePanel(index, graph, forcedNodeId) {
    const focusState = this.capturePanelFocus();
    this.sidePanel.empty();
    this.clearControlRefs();

    if (["detail", "links", "layout", "legend"].includes(this.state.sidePage)) {
      this.state.sidePage = "controls";
    }
    const pages = this.sidePanelPages();
    if (!pages.some(([id]) => id === this.state.sidePage)) this.state.sidePage = "inspect";

    const header = this.sidePanel.createDiv({ cls: "mwm-panel-header" });
    const titleWrap = header.createDiv({ cls: "mwm-panel-title-wrap" });
    titleWrap.createDiv({ cls: "mwm-panel-title", text: "Mini World Map" });
    titleWrap.createDiv({
      cls: "mwm-panel-subtitle",
      text: `${this.state.mode} - ${graph?.nodes?.length || 0} nodes`
    });

    const tabs = this.sidePanel.createDiv({ cls: "mwm-page-tabs" });
    for (const [pageId, label, icon] of pages) {
      const active = this.state.sidePage === pageId;
      const button = tabs.createEl("button", {
        cls: active ? "mwm-page-tab is-active" : "mwm-page-tab",
        attr: { type: "button", title: label, "aria-pressed": active ? "true" : "false" }
      });
      setIcon(button, icon);
      button.createSpan({ text: label });
      button.addEventListener("click", () => {
        this.state.sidePage = pageId;
        this.renderSidePanel(index, graph, forcedNodeId);
      });
    }

    const content = this.sidePanel.createDiv({ cls: `mwm-panel-content mwm-panel-content-${this.state.sidePage}` });
    this.sidePanelContent = content;
    try {
      if (this.state.sidePage === "view") this.renderViewPage(index, graph);
      else if (this.state.sidePage === "controls") this.renderControlsPage(index, graph);
      else if (this.state.sidePage === "defaults") this.renderDefaultsPage(index, graph);
      else this.renderInspectPage(index, graph, forcedNodeId);
    } finally {
      this.sidePanelContent = null;
    }
    this.restorePanelFocus(focusState);
  }

  renderViewPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "View");

    const search = this.createPanelSection(panel, "Search");
    this.searchInput = this.createPanelText(
      search,
      "search",
      "Search",
      this.state.search,
      "Notes and folders",
      value => {
        this.disableCompleteRoot();
        this.state.search = value.trim();
        this.scheduleRender(120);
      }
    );

    const modeActions = this.createPanelSection(panel, "Mode");
    const modeGrid = modeActions.createDiv({ cls: "mwm-panel-action-grid" });
    this.createPanelAction(modeGrid, "network", "Atlas", () => {
      this.state.mode = "atlas";
      this.state.showCompleteRoot = false;
      this.viewInitialized = false;
      this.resetAdaptiveTuning();
      this.render();
    }, this.state.mode === "atlas");
    this.createPanelAction(modeGrid, "locate-fixed", "Focus", () => {
      this.state.mode = "focus";
      this.state.focusPath = this.plugin.index.getActiveNotePath();
      this.state.showCompleteRoot = false;
      this.viewInitialized = false;
      this.resetAdaptiveTuning();
      this.render();
    }, this.state.mode === "focus");
    this.createPanelAction(modeGrid, "home", "Vault root", () => {
      this.resetToVaultRoot();
    });
    const currentRoot = graph?.rootId !== null && graph?.rootId !== undefined
      ? index.nodes.get(graph.rootId)
      : index.nodes.get(this.state.rootPath);
    const parentRootId = currentRoot && currentRoot.parentId !== null && currentRoot.parentId !== undefined
      ? currentRoot.parentId
      : null;
    const parentButton = this.createPanelAction(modeGrid, "arrow-up", "Parent root", () => {
      if (parentRootId === null) return;
      this.state.rootPath = parentRootId;
      this.state.mode = "atlas";
      this.state.showCompleteRoot = false;
      this.viewInitialized = false;
      this.resetAdaptiveTuning();
      this.render();
    });
    if (parentRootId === null) parentButton.disabled = true;
    this.createPanelAction(
      modeGrid,
      this.state.showCompleteRoot ? "x" : "route",
      this.state.showCompleteRoot ? "Exit complete" : "Complete root",
      () => {
        if (this.state.showCompleteRoot) {
          this.exitCompleteRoot();
          this.resetAdaptiveTuning();
          this.viewInitialized = false;
          this.render();
        } else {
          this.showCompleteCurrentRoot();
        }
      },
      this.state.showCompleteRoot
    );

    const appearance = this.createPanelSection(panel, "Appearance");
    const appearanceGrid = appearance.createDiv({ cls: "mwm-panel-action-grid mwm-panel-action-grid-three" });
    this.createPanelAction(appearanceGrid, "monitor", "Auto", () => this.setColorScheme("auto"), this.state.colorScheme === "auto");
    this.createPanelAction(appearanceGrid, "sun", "Day", () => this.setColorScheme("day"), this.state.colorScheme === "day");
    this.createPanelAction(appearanceGrid, "moon", "Night", () => this.setColorScheme("night"), this.state.colorScheme === "night");

    const commands = this.createPanelSection(panel, "Commands");
    const commandGrid = commands.createDiv({ cls: "mwm-panel-action-grid" });
    this.createPanelAction(commandGrid, "refresh-cw", "Rebuild", () => {
      this.plugin.rebuildIndex("manual");
    });
    this.createPanelAction(commandGrid, "maximize-2", "Full screen", () => this.toggleFullscreen(), this.state.fullscreen);
  }

  renderControlsPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Controls");
    const createPanelPageTitle = this.createPanelPageTitle;
    this.createPanelPageTitle = () => {};
    try {
      this.renderDetailPage(index, graph);
      this.renderLinksPage(index, graph);
      this.renderLayoutPage(index, graph);
    } finally {
      this.createPanelPageTitle = createPanelPageTitle;
    }
    this.renderLegendControls(panel);
    this.renderLegend(false);
  }

  renderDetailPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Detail");

    const budgets = this.createPanelSection(panel, "Budgets");
    this.depthInput = this.createPanelNumber(
      budgets,
      "atlas-depth",
      "Depth",
      this.state.atlasDepth,
      { min: "1", max: String(MAX_ATLAS_DEPTH) },
      value => {
        this.disableAutoDetail();
        this.disableCompleteRoot();
        this.state.atlasDepth = clampNumber(value, 1, MAX_ATLAS_DEPTH, this.plugin.settings.atlasDepth);
        this.render();
      }
    );
    this.nodeInput = this.createPanelNumber(
      budgets,
      "node-limit",
      "Nodes",
      this.state.nodeLimit,
      { min: "200", max: String(MAX_RENDER_NODE_LIMIT), step: "100" },
      value => {
        this.disableAutoDetail();
        this.disableCompleteRoot();
        this.state.nodeLimit = clampNumber(value, 200, MAX_RENDER_NODE_LIMIT, this.plugin.settings.renderNodeLimit);
        this.render();
      }
    );
    this.linkInput = this.createPanelNumber(
      budgets,
      "link-limit",
      "Link overlays",
      this.state.linkLimit,
      { min: "0", max: String(MAX_LINK_LIMIT) },
      value => {
        this.disableAutoDetail();
        this.disableCompleteRoot();
        this.state.linkLimit = clampNumber(value, 0, MAX_LINK_LIMIT, this.plugin.settings.linkLimit);
        this.render();
      }
    );

    const automation = this.createPanelSection(panel, "Automation");
    this.autoToggle = this.createPanelToggle(automation, "auto-detail", "Adaptive detail", this.state.autoDetail, checked => {
      this.state.autoDetail = checked;
      if (this.state.autoDetail) this.disableCompleteRoot();
      this.adaptiveInitialized = false;
      this.autoTuneCount = 0;
      this.render();
    });
  }

  renderLinksPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Links");

    const overlays = this.createPanelSection(panel, "Overlay");
    this.linkToggle = this.createPanelToggle(overlays, "show-link-overlay", "Show link overlay", this.state.showLinkOverlay, checked => {
      this.disableCompleteRoot();
      this.state.showLinkOverlay = checked;
      this.render();
    });
    this.linkHoverSelect = this.createPanelSelect(
      overlays,
      "hover-highlight-mode",
      "Hover highlight",
      normalizeHoverHighlightMode(this.state.hoverHighlightMode),
      HOVER_HIGHLIGHT_MODE_OPTIONS,
      value => {
        const previousUsesHoverLinks = hoverHighlightsNoteLinks(this.state.hoverHighlightMode);
        this.state.hoverHighlightMode = normalizeHoverHighlightMode(value);
        this.state.enableLinkHover = hoverHighlightsNoteLinks(this.state.hoverHighlightMode);
        this.hoverLink = null;
        if (previousUsesHoverLinks !== this.state.enableLinkHover) this.render();
        else this.applyPersistentHighlight();
      }
    );

    const external = this.createPanelSection(panel, "Outside Root");
    this.externalToggle = this.createPanelToggle(external, "show-external-links", "Show external links", this.state.showExternalLinks, checked => {
      this.disableCompleteRoot();
      this.state.showExternalLinks = checked;
      this.render();
    });
    this.externalModeSelect = this.createPanelSelect(
      external,
      "external-detail-mode",
      "Outside detail",
      this.state.externalDetailMode,
      [
        ["grouped", "Groups"],
        ["selected", "Selected"],
        ["exact", "Exact"]
      ],
      value => {
        this.disableCompleteRoot();
        this.state.externalDetailMode = value;
        this.resetAdaptiveTuning();
        this.render();
      }
    );
    this.externalLimitInput = this.createPanelNumber(
      external,
      "external-link-anchor-limit",
      "Exact outside files",
      this.state.externalLinkAnchorLimit,
      { min: "0", max: String(MAX_EXTERNAL_LINK_ANCHOR_LIMIT) },
      value => {
        this.disableAutoDetail();
        this.disableCompleteRoot();
        this.state.externalLinkAnchorLimit = clampNumber(value, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, this.plugin.settings.externalLinkAnchorLimit);
        this.render();
      }
    );
  }

  renderLayoutPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Layout");

    const zoom = this.createPanelSection(panel, "Zoom");
    const zoomActions = zoom.createDiv({ cls: "mwm-panel-action-row" });
    this.createPanelAction(zoomActions, "zoom-out", "Out", () => this.adjustZoom(-1));
    this.createPanelAction(zoomActions, "zoom-in", "In", () => this.adjustZoom(1));
    this.createPanelAction(zoomActions, "maximize", "Fit", () => this.fitToView());
    this.createPanelAction(zoomActions, "rotate-ccw", "Reset", () => this.resetViewZoom());

    const range = this.createPanelRange(
      zoom,
      "zoom",
      "Zoom",
      "500",
      { min: "0", max: String(ZOOM_SLIDER_STEPS), step: "1" },
      value => {
        const viewport = this.canvasViewport();
        const minZoom = this.canvasMinZoom(viewport, this.lastLayout);
        const maxZoom = this.canvasMaxZoom(viewport, this.lastLayout);
        this.setCanvasZoom(sliderValueToZoom(value, minZoom, maxZoom), null, true);
      }
    );
    this.zoomInput = range.input;
    this.zoomLabel = range.valueEl;
    this.syncZoomControls();

    const spacing = this.createPanelSection(panel, "Spacing");
    this.columnInput = this.createPanelNumber(
      spacing,
      "column-spacing",
      "Ring",
      this.state.columnSpacing,
      { min: String(MIN_RING_SPACING), max: String(MAX_RING_SPACING), step: "10" },
      value => {
        this.state.columnSpacing = clampNumber(value, MIN_RING_SPACING, MAX_RING_SPACING, DEFAULT_RING_SPACING);
        this.render();
      }
    );
    this.rowInput = this.createPanelNumber(
      spacing,
      "row-spacing",
      "Gap",
      this.state.rowSpacing,
      { min: String(MIN_NODE_SPACING), max: String(MAX_NODE_SPACING), step: "2" },
      value => {
        this.state.rowSpacing = clampNumber(value, MIN_NODE_SPACING, MAX_NODE_SPACING, DEFAULT_NODE_SPACING);
        this.render();
      }
    );

    const labels = this.createPanelSection(panel, "Labels");
    this.labelVisibilitySelect = this.createPanelSelect(
      labels,
      "label-visibility",
      "Names",
      normalizeLabelVisibility(this.state.labelVisibility),
      LABEL_VISIBILITY_OPTIONS,
      value => {
        this.state.labelVisibility = normalizeLabelVisibility(value);
        this.requestCanvasDraw("full");
      }
    );

    const motion = this.createPanelSection(panel, "Motion");
    const motionActions = motion.createDiv({ cls: "mwm-panel-action-row" });
    const spinning = this.state.swirlStrength > 0;
    this.createPanelAction(motionActions, spinning ? "pause" : "play", spinning ? "Stop" : "Spin", () => {
      this.setSpinSpeed(spinning ? 0 : DEFAULT_SWIRL_BUTTON_STRENGTH, { render: true });
    }, spinning);
    const swirl = this.createPanelRange(
      motion,
      "swirl-strength",
      "Spin speed",
      String(this.state.swirlStrength),
      { min: "0", max: String(MAX_SWIRL_STRENGTH), step: "1" },
      (value, input, valueEl) => {
        this.setSpinSpeed(value);
        valueEl.textContent = `${Math.round(this.state.swirlStrength)}%`;
      }
    );
    this.swirlInput = swirl.input;
    this.swirlLabel = swirl.valueEl;
    this.swirlLabel.textContent = `${Math.round(this.state.swirlStrength)}%`;
  }

  renderDefaultsPage(index, graph) {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Defaults");

    const budgets = this.createPanelSection(panel, "Default Budgets");
    this.createPanelNumber(
      budgets,
      "default-atlas-depth",
      "Atlas depth",
      this.plugin.settings.atlasDepth,
      { min: "1", max: String(MAX_ATLAS_DEPTH) },
      value => {
        this.plugin.settings.atlasDepth = clampNumber(value, 1, MAX_ATLAS_DEPTH, DEFAULT_SETTINGS.atlasDepth);
        void this.plugin.saveSettings();
      }
    );
    this.createPanelNumber(
      budgets,
      "default-render-node-limit",
      "Render nodes",
      this.plugin.settings.renderNodeLimit,
      { min: "200", max: String(MAX_RENDER_NODE_LIMIT), step: "100" },
      value => {
        this.plugin.settings.renderNodeLimit = clampNumber(value, 200, MAX_RENDER_NODE_LIMIT, DEFAULT_SETTINGS.renderNodeLimit);
        void this.plugin.saveSettings();
      }
    );
    this.createPanelNumber(
      budgets,
      "default-link-limit",
      "Link overlays",
      this.plugin.settings.linkLimit,
      { min: "0", max: String(MAX_LINK_LIMIT) },
      value => {
        this.plugin.settings.linkLimit = clampNumber(value, 0, MAX_LINK_LIMIT, DEFAULT_SETTINGS.linkLimit);
        void this.plugin.saveSettings();
      }
    );
    this.createPanelNumber(
      budgets,
      "default-external-link-anchor-limit",
      "Exact outside files",
      this.plugin.settings.externalLinkAnchorLimit,
      { min: "0", max: String(MAX_EXTERNAL_LINK_ANCHOR_LIMIT) },
      value => {
        this.plugin.settings.externalLinkAnchorLimit = clampNumber(value, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, DEFAULT_SETTINGS.externalLinkAnchorLimit);
        void this.plugin.saveSettings();
      }
    );

    const toggles = this.createPanelSection(panel, "Default Toggles");
    this.createPanelToggle(toggles, "default-adaptive-detail", "Adaptive detail", this.plugin.settings.adaptiveDetail, checked => {
      this.plugin.settings.adaptiveDetail = checked;
      void this.plugin.saveSettings();
    });
    this.createPanelToggle(toggles, "default-show-link-overlay", "Show link overlay", this.plugin.settings.showLinkOverlay, checked => {
      this.plugin.settings.showLinkOverlay = checked;
      void this.plugin.saveSettings();
    });
    this.createPanelSelect(
      toggles,
      "default-hover-highlight-mode",
      "Hover highlight",
      normalizeHoverHighlightMode(this.plugin.settings.hoverHighlightMode),
      HOVER_HIGHLIGHT_MODE_OPTIONS,
      value => {
        this.plugin.settings.hoverHighlightMode = normalizeHoverHighlightMode(value);
        this.plugin.settings.enableLinkHover = hoverHighlightsNoteLinks(this.plugin.settings.hoverHighlightMode);
        void this.plugin.saveSettings();
      }
    );
    this.createPanelToggle(toggles, "default-show-external-links", "External links", this.plugin.settings.showExternalLinks, checked => {
      this.plugin.settings.showExternalLinks = checked;
      void this.plugin.saveSettings();
    });
    this.createPanelToggle(toggles, "default-include-unresolved-links", "Unresolved links", this.plugin.settings.includeUnresolvedLinks, checked => {
      this.plugin.settings.includeUnresolvedLinks = checked;
      void this.plugin.saveSettings();
    });

    const layoutDefaults = this.createPanelSection(panel, "Default Layout");
    this.createPanelSelect(
      layoutDefaults,
      "default-label-visibility",
      "Names",
      normalizeLabelVisibility(this.plugin.settings.labelVisibility),
      LABEL_VISIBILITY_OPTIONS,
      value => {
        this.plugin.settings.labelVisibility = normalizeLabelVisibility(value);
        void this.plugin.saveSettings({ rebuild: false });
      }
    );
    this.createPanelNumber(
      layoutDefaults,
      "default-swirl-strength",
      "Spin speed",
      this.plugin.settings.swirlStrength,
      { min: "0", max: String(MAX_SWIRL_STRENGTH), step: "1" },
      value => {
        this.plugin.settings.swirlStrength = clampNumber(value, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH);
        void this.plugin.saveSettings({ rebuild: false });
      }
    );

    const appearance = this.createPanelSection(panel, "Default Appearance");
    this.createPanelSelect(
      appearance,
      "default-color-scheme",
      "Color scheme",
      this.plugin.settings.colorScheme || DEFAULT_SETTINGS.colorScheme,
      [
        ["auto", "Auto"],
        ["day", "Day"],
        ["night", "Night"]
      ],
      value => {
        const scheme = normalizeColorScheme(value);
        this.setColorScheme(scheme, false);
        this.plugin.settings.colorScheme = scheme;
        for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
          const view = leaf.view;
          if (view && view !== this && typeof view.setColorScheme === "function") view.setColorScheme(scheme, false);
        }
        void this.plugin.saveSettings({ rebuild: false });
      }
    );

    const outside = this.createPanelSection(panel, "Outside Root");
    this.createPanelSelect(
      outside,
      "default-external-detail-mode",
      "Outside detail",
      this.plugin.settings.externalDetailMode || DEFAULT_SETTINGS.externalDetailMode,
      [
        ["grouped", "Groups"],
        ["selected", "Selected"],
        ["exact", "Exact"]
      ],
      value => {
        this.plugin.settings.externalDetailMode = value;
        void this.plugin.saveSettings();
      }
    );

    const ignores = this.createPanelSection(panel, "Ignored Folders");
    this.createPanelTextArea(
      ignores,
      "default-ignore-folders",
      "Folder paths",
      (this.plugin.settings.ignoreFolders || []).join("\n"),
      value => {
        this.plugin.settings.ignoreFolders = value
          .split("\n")
          .map(line => line.trim())
          .filter(Boolean);
        void this.plugin.saveSettings();
      }
    );
  }

  renderLegendPage() {
    const panel = this.getSidePanelTarget();
    this.createPanelPageTitle(panel, "Legend");
    this.renderLegendControls(panel);
    this.renderLegend(false);
  }

  renderLegendControls(panel) {
    const section = this.createPanelSection(panel, "Legend");
    const hidden = this.hiddenLegendItemSet();
    for (const [id, label, text] of LEGEND_ITEM_DEFINITIONS) {
      this.createPanelToggle(section, `legend-${id}`, label, !hidden.has(id), checked => {
        this.setLegendItemHidden(id, !checked);
      }).title = text;
    }
  }

  hiddenLegendItemSet() {
    return new Set(Array.isArray(this.state.hiddenLegendItems) ? this.state.hiddenLegendItems : []);
  }

  setLegendItemHidden(id, hidden) {
    const validIds = new Set(LEGEND_ITEM_DEFINITIONS.map(([itemId]) => itemId));
    if (!validIds.has(id)) return;
    const hiddenSet = this.hiddenLegendItemSet();
    if (hidden) hiddenSet.add(id);
    else hiddenSet.delete(id);
    const next = Array.from(hiddenSet).filter(itemId => validIds.has(itemId));
    this.state.hiddenLegendItems = next;
    this.plugin.settings.hiddenLegendItems = next.slice();
    void this.plugin.saveSettings({ rebuild: false });
    if (!this.state.fullscreen && this.lastCanvasBundle) {
      this.renderSidePanel(this.lastCanvasBundle.index, this.lastCanvasBundle.graph);
    }
  }

  renderInspectPage(index, graph, forcedNodeId) {
    const panel = this.getSidePanelTarget();

    if (this.selectedLink && forcedNodeId === undefined) {
      this.renderLinkPanel(index, graph, this.selectedLink);
      return;
    }

    const nodeId = forcedNodeId ?? this.selectedNodeId ?? graph?.focusId ?? graph?.rootId;
    const node = nodeId !== null && nodeId !== undefined ? graphNode(index, graph, nodeId) : null;

    panel.createDiv({ cls: "mwm-side-title", text: node ? node.title : "Mini World Map" });

    if (!node) {
      panel.createDiv({ cls: "mwm-side-muted", text: "Select a node to inspect it." });
      return;
    }

    const path = panel.createDiv({ cls: "mwm-side-path", text: node.path || "/" });
    path.setAttribute("title", node.path || "/");

    const nodeType = node.externalProxy
      ? `outside ${node.type}`
      : node.type === "folder" && node.representativeFile
        ? "folder + meta file"
        : node.isRepresentativeFile
          ? "merged meta file"
          : node.type;
    const facts = [
      ["Type", nodeType],
      ["Depth", String(node.depth)],
      ["Notes", String(node.noteCount || node.descendantCount || 0)],
      ["Out", String(node.linkCount || 0)],
      ["In", String(node.backlinkCount || 0)]
    ];

    const table = panel.createDiv({ cls: "mwm-facts" });
    for (const [label, value] of facts) {
      table.createSpan({ text: label });
      table.createSpan({ text: value });
    }

    const actions = panel.createDiv({ cls: "mwm-side-actions" });
    if (node.type === "note") {
      this.createIconButton(actions, "file-text", "Open note", () => this.openNode(node.id), "");
      this.createIconButton(actions, "locate-fixed", "Focus note", () => {
        this.state.mode = "focus";
        this.state.focusPath = node.id;
        this.state.showCompleteRoot = false;
        this.viewInitialized = false;
        this.resetAdaptiveTuning();
        this.render();
      }, "");
    }
    if (node.type === "folder") {
      this.createIconButton(actions, "folder-open", "Use as atlas root", () => {
        this.state.mode = "atlas";
        this.state.rootPath = node.id;
        this.state.showCompleteRoot = false;
        this.viewInitialized = false;
        this.resetAdaptiveTuning();
        this.render();
      }, "");
      if (node.representativeFile) {
        this.createIconButton(actions, "file-text", "Open representative note", () => this.openNode(node.representativeFile), "");
      }
    }
    if (node.type === "external" && node.externalAnchorPath) {
      const anchor = index.nodes.get(node.externalAnchorPath);
      if (anchor && anchor.type === "folder") {
        this.createIconButton(actions, "folder-open", "Use outside branch as root", () => {
          this.state.mode = "atlas";
          this.state.rootPath = anchor.id;
          this.state.showCompleteRoot = false;
          this.viewInitialized = false;
          this.resetAdaptiveTuning();
          this.render();
        }, "");
      }
      if (anchor && anchor.type === "note") {
        this.createIconButton(actions, "file-text", "Open outside note", () => this.openNode(anchor.id), "");
      }
    }

    if (node.type === "external") {
      panel.createDiv({
        cls: "mwm-side-muted",
        text: "This is a summarized outside branch. It keeps links visible when the atlas root is focused on a smaller subtree."
      });
    } else {
      this.renderNeighborList(index, node);
    }
  }

  renderLinkPanel(index, graph, edge) {
    const panel = this.getSidePanelTarget();
    const source = graphNode(index, graph, edge.source);
    const target = graphNode(index, graph, edge.target);
    panel.createDiv({ cls: "mwm-side-title", text: "Link overlay" });
    panel.createDiv({
      cls: "mwm-side-muted",
      text: "Aggregated internal Markdown links between visible nodes. Folder nodes can include hidden descendants; outside links point to exact outside files when the current root is narrowed."
    });

    const table = panel.createDiv({ cls: "mwm-facts mwm-link-facts" });
    const facts = [
      ["Source", source ? source.title : edge.source],
      ["Target", target ? target.title : edge.target],
      ["Weight", String(edge.weight || 0)],
      ["Raw edges", String(edge.rawCount || edge.weight || 0)],
      ["Unresolved", String(edge.unresolvedCount || 0)],
      ["External", String(edge.externalCount || 0)]
    ];
    for (const [label, value] of facts) {
      table.createSpan({ text: label });
      table.createSpan({ text: value });
    }

    const actions = panel.createDiv({ cls: "mwm-side-actions" });
    if (source) {
      const button = actions.createEl("button", { cls: "mwm-text-button", attr: { type: "button" } });
      button.textContent = "Source";
      button.addEventListener("click", () => {
        this.state.sidePage = "inspect";
        this.selectedLink = null;
        this.selectedNodeId = source.id;
        if (this.shouldRerenderForSelection()) this.render();
        else {
          this.applyPersistentHighlight();
          if (!this.state.fullscreen) this.renderSidePanel(index, graph, source.id);
        }
      });
    }
    if (target) {
      const button = actions.createEl("button", { cls: "mwm-text-button", attr: { type: "button" } });
      button.textContent = "Target";
      button.addEventListener("click", () => {
        this.state.sidePage = "inspect";
        this.selectedLink = null;
        this.selectedNodeId = target.id;
        if (this.shouldRerenderForSelection()) this.render();
        else {
          this.applyPersistentHighlight();
          if (!this.state.fullscreen) this.renderSidePanel(index, graph, target.id);
        }
      });
    }
  }

  renderLegend(showHeading = true) {
    const panel = this.getSidePanelTarget();
    if (showHeading) panel.createDiv({ cls: "mwm-side-heading", text: "Legend" });
    const legend = panel.createDiv({ cls: "mwm-legend" });
    const hidden = this.hiddenLegendItemSet();

    for (const [id, label, text, cls] of LEGEND_ITEM_DEFINITIONS) {
      if (hidden.has(id)) continue;
      const item = legend.createDiv({ cls: "mwm-legend-item" });
      item.createSpan({ cls: `mwm-legend-mark ${cls}` });
      item.createSpan({ cls: "mwm-legend-label", text: label });
      item.createSpan({ cls: "mwm-legend-text", text });
    }
  }

  renderNeighborList(index, node) {
    const panel = this.getSidePanelTarget();
    const mergedIds = [node.id];
    if (node.type === "folder" && node.representativeFile) mergedIds.push(node.representativeFile);
    const outgoing = uniqueEdgesByEndpoint(
      mergedIds.flatMap(id => index.linkEdgesBySource.get(id) || []),
      "target"
    ).sort((a, b) => b.weight - a.weight);
    const incoming = uniqueEdgesByEndpoint(
      mergedIds.flatMap(id => index.linkEdgesByTarget.get(id) || []),
      "source"
    ).sort((a, b) => b.weight - a.weight);

    panel.createDiv({ cls: "mwm-side-heading", text: `Outgoing (${outgoing.length})` });
    this.renderEdgeList(index, outgoing, "target");

    panel.createDiv({ cls: "mwm-side-heading", text: `Backlinks (${incoming.length})` });
    this.renderEdgeList(index, incoming, "source");
  }

  renderEdgeList(index, edges, side) {
    const panel = this.getSidePanelTarget();
    if (!edges.length) {
      panel.createDiv({ cls: "mwm-side-muted", text: "None" });
      return;
    }

    const list = panel.createEl("ul", { cls: "mwm-edge-list" });
    for (const edge of edges) {
      const target = index.nodes.get(edge[side]);
      if (!target) continue;
      const item = list.createEl("li");
      const button = item.createEl("button", { attr: { type: "button", title: target.path || target.title } });
      button.textContent = `${target.title} (${edge.weight})`;
      button.addEventListener("click", () => {
        this.state.sidePage = "inspect";
        this.selectedLink = null;
        this.selectedNodeId = target.id;
        this.applyPersistentHighlight();
        const bundle = this.lastCanvasBundle;
        if (!this.state.fullscreen && bundle) this.renderSidePanel(bundle.index, bundle.graph, target.id);
      });
    }
  }

  async openNode(path, evt) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const targetPane = evt && (evt.metaKey || evt.ctrlKey) ? "split" : "tab";
    await this.app.workspace.openLinkText(file.path, "", targetPane, { active: true });
  }
}

class MiniWorldMapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Mini World Map" });

    new Setting(containerEl)
      .setName("Color scheme")
      .setDesc("Auto follows Obsidian. Day and Night force Mini World Map's own palette.")
      .addDropdown(dropdown => dropdown
        .addOption("auto", "Auto")
        .addOption("day", "Day")
        .addOption("night", "Night")
        .setValue(this.plugin.settings.colorScheme || DEFAULT_SETTINGS.colorScheme)
        .onChange(async value => {
          const scheme = normalizeColorScheme(value);
          this.plugin.settings.colorScheme = scheme;
          for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
            const view = leaf.view;
            if (view && typeof view.setColorScheme === "function") view.setColorScheme(scheme, false);
          }
          await this.plugin.saveSettings({ rebuild: false });
        }));

    new Setting(containerEl)
      .setName("Default atlas depth")
      .setDesc("How many hierarchy levels to render before deeper nodes are aggregated.")
      .addSlider(slider => slider
        .setLimits(1, 20, 1)
        .setValue(this.plugin.settings.atlasDepth)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.atlasDepth = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default link overlay limit")
      .setDesc("Maximum aggregated cross-links to draw in the map.")
      .addText(text => text
        .setPlaceholder(String(DEFAULT_SETTINGS.linkLimit))
        .setValue(String(this.plugin.settings.linkLimit))
        .onChange(async value => {
          this.plugin.settings.linkLimit = clampNumber(value, 0, MAX_LINK_LIMIT, DEFAULT_SETTINGS.linkLimit);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default render node limit")
      .setDesc("Maximum visible nodes to draw before lower-priority nodes are summarized.")
      .addText(text => text
        .setPlaceholder(String(DEFAULT_SETTINGS.renderNodeLimit))
        .setValue(String(this.plugin.settings.renderNodeLimit))
        .onChange(async value => {
          this.plugin.settings.renderNodeLimit = clampNumber(value, 200, MAX_RENDER_NODE_LIMIT, DEFAULT_SETTINGS.renderNodeLimit);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Adaptive detail by default")
      .setDesc("Let Mini World Map adjust depth, node budget, and link budget after measuring render cost.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.adaptiveDetail)
        .onChange(async value => {
          this.plugin.settings.adaptiveDetail = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default label visibility")
      .setDesc("Auto shows important names by zoom. Hover only keeps names hidden until a node is hovered or selected.")
      .addDropdown(dropdown => {
        for (const [value, label] of LABEL_VISIBILITY_OPTIONS) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(normalizeLabelVisibility(this.plugin.settings.labelVisibility))
          .onChange(async value => {
            this.plugin.settings.labelVisibility = normalizeLabelVisibility(value);
            await this.plugin.saveSettings({ rebuild: false });
          });
      });

    new Setting(containerEl)
      .setName("Default spin speed")
      .setDesc("How fast rings orbit when spin is enabled in the map view.")
      .addSlider(slider => slider
        .setLimits(0, MAX_SWIRL_STRENGTH, 1)
        .setValue(this.plugin.settings.swirlStrength)
        .setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.swirlStrength = clampNumber(value, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH);
          await this.plugin.saveSettings({ rebuild: false });
        }));

    new Setting(containerEl)
      .setName("Show link overlay by default")
      .setDesc("Layer Obsidian links over the hierarchy when the view opens.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showLinkOverlay)
        .onChange(async value => {
          this.plugin.settings.showLinkOverlay = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Default hover highlight")
      .setDesc("Choose what the graph highlights when the cursor is over a node.")
      .addDropdown(dropdown => {
        for (const [value, label] of HOVER_HIGHLIGHT_MODE_OPTIONS) {
          dropdown.addOption(value, label);
        }
        dropdown
          .setValue(normalizeHoverHighlightMode(this.plugin.settings.hoverHighlightMode))
          .onChange(async value => {
            this.plugin.settings.hoverHighlightMode = normalizeHoverHighlightMode(value);
            this.plugin.settings.enableLinkHover = hoverHighlightsNoteLinks(this.plugin.settings.hoverHighlightMode);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show external links by default")
      .setDesc("When an atlas root is selected, keep links to exact notes outside that root visible around outside branch anchors.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showExternalLinks)
        .onChange(async value => {
          this.plugin.settings.showExternalLinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Outside detail mode")
      .setDesc("Groups is calmest. Selected uses selection context on the next render. Exact draws all outside files up to the limit.")
      .addDropdown(dropdown => dropdown
        .addOption("grouped", "Groups")
        .addOption("selected", "Selected")
        .addOption("exact", "Exact")
        .setValue(this.plugin.settings.externalDetailMode || DEFAULT_SETTINGS.externalDetailMode)
        .onChange(async value => {
          this.plugin.settings.externalDetailMode = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Exact outside file limit")
      .setDesc("Maximum exact outside linked files to draw before the remainder is grouped.")
      .addText(text => text
        .setPlaceholder(String(DEFAULT_SETTINGS.externalLinkAnchorLimit))
        .setValue(String(this.plugin.settings.externalLinkAnchorLimit))
        .onChange(async value => {
          this.plugin.settings.externalLinkAnchorLimit = clampNumber(value, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, DEFAULT_SETTINGS.externalLinkAnchorLimit);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Include unresolved links")
      .setDesc("Represent unresolved internal links as temporary nodes.")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeUnresolvedLinks)
        .onChange(async value => {
          this.plugin.settings.includeUnresolvedLinks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Ignored folders")
      .setDesc("One path per line. Matching folders are excluded from the map.")
      .addTextArea(text => text
        .setValue((this.plugin.settings.ignoreFolders || []).join("\n"))
        .onChange(async value => {
          this.plugin.settings.ignoreFolders = value
            .split("\n")
            .map(line => line.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        }));
  }
}

function layoutVisibleGraph(index, graph, state = {}) {
  const positions = new Map();
  const visible = new Set(graph.nodes.map(node => node.id));
  const baseRingGap = clampNumber(state.columnSpacing, MIN_RING_SPACING, MAX_RING_SPACING, DEFAULT_RING_SPACING);
  const baseNodeGap = clampNumber(state.rowSpacing, MIN_NODE_SPACING, MAX_NODE_SPACING, DEFAULT_NODE_SPACING);
  const padding = 340;
  let trimmed = false;

  const graphNodesById = graph.nodesById || new Map(graph.nodes.map(node => [node.id, node]));
  const normalNodes = graph.nodes.filter(node => !node.externalProxy && node.type !== "external");
  const normalNodeIds = new Set(normalNodes.map(node => node.id));
  const spacingProfile = adaptiveLayoutSpacing(graph, normalNodeIds, baseRingGap, baseNodeGap);
  const ringGap = spacingProfile.ringGap;
  const nodeGap = spacingProfile.nodeGap;
  const rootId = graph.rootId && normalNodeIds.has(graph.rootId)
    ? graph.rootId
    : normalNodeIds.has(ROOT_ID)
      ? ROOT_ID
      : normalNodes.length
        ? normalNodes[0].id
        : null;

  const childrenByParent = new Map();
  for (const [parentId, childIds] of index.childrenByParent.entries()) {
    if (!normalNodeIds.has(parentId)) continue;
    const children = childIds.filter(childId => normalNodeIds.has(childId));
    if (children.length) childrenByParent.set(parentId, children);
  }

  const metrics = new Map();
  function measureSubtree(id, depth, visiting = new Set()) {
    if (metrics.has(id)) return metrics.get(id);
    if (visiting.has(id)) {
      const fallback = { weight: 1, maxDepth: depth, count: 1 };
      metrics.set(id, fallback);
      return fallback;
    }

    visiting.add(id);
    const children = childrenByParent.get(id) || [];
    const incidentPressure = spacingProfile.incidentPressureByNode.get(id) || 0;
    let weight = Math.min(9, incidentPressure * 0.24);
    let count = 1;
    let maxDepth = depth;
    for (const childId of children) {
      const childMetrics = measureSubtree(childId, depth + 1, visiting);
      weight += childMetrics.weight;
      count += childMetrics.count;
      maxDepth = Math.max(maxDepth, childMetrics.maxDepth);
    }
    visiting.delete(id);

    const metricsForNode = {
      weight: Math.max(1, weight || 1),
      maxDepth,
      count
    };
    metrics.set(id, metricsForNode);
    return metricsForNode;
  }

  const reachable = new Set();
  function collectReachable(id) {
    if (id === null || id === undefined || reachable.has(id)) return;
    reachable.add(id);
    for (const childId of childrenByParent.get(id) || []) collectReachable(childId);
  }

  if (rootId !== null) {
    measureSubtree(rootId, 0);
    collectReachable(rootId);
  }

  const externalGroups = graph.nodes
    .filter(node => node.type === "external" && !node.externalProxy)
    .sort(compareNodes);
  const externalFiles = graph.nodes
    .filter(node => node.externalProxy)
    .sort(compareNodes);
  const orphanNodes = normalNodes
    .filter(node => node.id !== rootId && !reachable.has(node.id))
    .sort(compareNodes);

  const rootMetrics = rootId !== null ? metrics.get(rootId) || { weight: 1, maxDepth: 0, count: 1 } : { weight: 0, maxDepth: 0, count: 0 };
  const maxTreeDepth = Math.max(0, rootMetrics.maxDepth || 0);
  const ringSpacing = ringGap;

  if (rootId !== null) {
    positions.set(rootId, {
      x: 0,
      y: 0,
      depth: 0,
      angle: -Math.PI / 2,
      radius: 0,
      labelSide: 1,
      centerX: 0,
      centerY: 0
    });

    placeRadialChildren(
      rootId,
      0,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2,
      -Math.PI / 2,
      childrenByParent,
      metrics,
      positions,
      spacingProfile.branchFanSpan,
      spacingProfile,
      rootId
    );
  }

  let maxPlacedRadius = Math.max(maxRadiusFromPositions(positions), ringGap);
  if (orphanNodes.length) {
    trimmed = true;
    maxPlacedRadius = Math.max(
      maxPlacedRadius,
      placeOuterCircleNodes(orphanNodes, positions, graph, maxPlacedRadius + ringSpacing * 0.72, nodeGap, -Math.PI / 2, {
        depth: maxTreeDepth + 1
      })
    );
  }

  if (externalGroups.length) {
    maxPlacedRadius = Math.max(
      maxPlacedRadius,
      placeOuterCircleNodes(externalGroups, positions, graph, maxPlacedRadius + ringSpacing * 0.62, nodeGap * 1.15, -Math.PI / 3, {
        depth: maxTreeDepth + 1,
        external: true,
        externalGroup: true
      })
    );
  }

  if (externalFiles.length) {
    maxPlacedRadius = Math.max(
      maxPlacedRadius,
      placeOuterCircleNodes(externalFiles, positions, graph, maxPlacedRadius + Math.max(220, ringSpacing * 0.52), nodeGap, -Math.PI / 5, {
        depth: maxTreeDepth + 2,
        external: true,
        externalFile: true
      })
    );
  }

  const ringTargets = assignDepthRingTargets(positions, graph, spacingProfile, nodeGap);
  resolveRadialCollisions(positions, graph, spacingProfile, nodeGap, ringTargets);
  enforceDepthRingBands(positions, graph, spacingProfile, nodeGap, ringTargets);
  if (spacingProfile.radiusExpansion > 1.001) {
    applyAdaptiveRadiusExpansion(positions, ringTargets, spacingProfile);
  }
  const spinSpeed = clampFloat(
    clampNumber(state.swirlStrength, 0, MAX_SWIRL_STRENGTH, DEFAULT_SWIRL_STRENGTH) / MAX_SWIRL_STRENGTH,
    0,
    1,
    0
  );
  const swirlStrength = spinSpeed > 0.001
    ? clampFloat(0.24 + spinSpeed * 0.34, 0.24, 0.58, 0.36)
    : 0;
  if (swirlStrength > 0.001) applyRadialSwirl(positions, graph, spacingProfile, swirlStrength);
  maxPlacedRadius = Math.max(maxPlacedRadius, maxRadiusFromPositions(positions));

  const routeBundle = computeLinkRoutes(
    graph.linkEdges,
    positions,
    maxTreeDepth + (externalGroups.length || externalFiles.length ? 2 : orphanNodes.length ? 1 : 0),
    ringSpacing,
    maxPlacedRadius + Math.max(150, ringSpacing * 0.35),
    spacingProfile.routeGapFactor
  );
  const bounds = radialLayoutBounds(positions, Math.max(routeBundle.maxRadius, maxPlacedRadius + Math.max(160, ringSpacing * 0.34)));
  const offsetX = padding - bounds.minX;
  const offsetY = padding - bounds.minY;
  shiftRadialLayout(positions, routeBundle.routes, offsetX, offsetY);
  anchorLayoutHomePositions(positions);
  const rings = computeLayoutRings(positions, ringTargets);

  return {
    positions,
    width: Math.max(900, bounds.maxX - bounds.minX + padding * 2),
    height: Math.max(520, bounds.maxY - bounds.minY + padding * 2),
    trimmed: trimmed || Boolean(graph.hiddenNodeCount),
    linkRoutes: routeBundle.routes,
    rings,
    radiusExpansion: spacingProfile.radiusExpansion,
    swirlStrength,
    spinSpeed,
    centerX: offsetX,
    centerY: offsetY
  };
}

function adaptiveLayoutSpacing(graph, normalNodeIds, baseRingGap, baseNodeGap) {
  const incidentPressureByNode = new Map();
  let totalPressure = 0;
  let externalPressure = 0;

  for (const edge of graph.linkEdges || []) {
    const weightScore = Math.min(7, Math.log2((edge.weight || 1) + 1));
    const rawScore = Math.min(6, Math.log2((edge.rawCount || edge.weight || 1) + 1));
    const edgePressure = 0.75
      + weightScore * 0.62
      + rawScore * 0.28
      + (edge.unresolvedCount ? 0.35 : 0)
      + (edge.externalCount ? 0.85 : 0);

    totalPressure += edgePressure;
    if (edge.externalCount) externalPressure += edgePressure;

    for (const id of [edge.source, edge.target]) {
      if (!id && id !== ROOT_ID) continue;
      incidentPressureByNode.set(id, (incidentPressureByNode.get(id) || 0) + edgePressure);
    }
  }

  let maxIncidentPressure = 0;
  for (const pressure of incidentPressureByNode.values()) {
    maxIncidentPressure = Math.max(maxIncidentPressure, pressure);
  }

  const visibleNodeCount = Math.max(1, (graph.nodes && graph.nodes.length) || normalNodeIds.size || 1);
  const nodeDensity = graphNodeDensityProfile(graph, normalNodeIds);
  const averagePressure = totalPressure / visibleNodeCount;
  const overlayDensity = ((graph.linkEdges || []).length || 0) / visibleNodeCount;
  const hubPressure = maxIncidentPressure / Math.max(1, Math.sqrt(visibleNodeCount) * 1.65);
  const combinedPressure = averagePressure
    + Math.sqrt(Math.max(0, hubPressure)) * 0.58
    + Math.min(1.6, overlayDensity) * 0.3
    + (externalPressure / visibleNodeCount) * 0.32;
  const pressureRoot = Math.sqrt(Math.max(0, combinedPressure));

  const nodeFactor = clampFloat(
    1.2 + pressureRoot * 0.92 + Math.min(0.86, averagePressure * 0.105),
    1.2,
    5.8,
    1
  );
  const ringFactor = clampFloat(
    1.08 + pressureRoot * 0.34 + Math.min(0.34, averagePressure * 0.044),
    1.08,
    2.15,
    1
  );
  const fanFactor = clampFloat(
    0.62 + pressureRoot * 0.24 + Math.min(0.3, overlayDensity * 0.17),
    0.62,
    1.35,
    0.68
  );
  const routeGapFactor = clampFloat(
    0.9 + pressureRoot * 0.38 + Math.min(0.42, overlayDensity * 0.2),
    0.9,
    2.55,
    1
  );
  const countExpansion = Math.max(0, Math.log2(nodeDensity.normalCount / 520)) * 0.035;
  const ringExpansion = Math.max(0, Math.sqrt(nodeDensity.maxRingCount / 96) - 1) * 0.16;
  const averageRingExpansion = Math.max(0, Math.sqrt(nodeDensity.averageRingCount / 64) - 1) * 0.1;
  const pressureExpansion = Math.max(0, pressureRoot - 0.75) * 0.028;
  const radiusExpansion = clampFloat(
    1 + countExpansion + ringExpansion + averageRingExpansion + pressureExpansion,
    1,
    1.56,
    1
  );

  return {
    baseRingGap,
    baseNodeGap,
    ringGap: clampNumber(baseRingGap * ringFactor, MIN_RING_SPACING, 4200, baseRingGap),
    nodeGap: clampNumber(baseNodeGap * nodeFactor, 86, 860, baseNodeGap),
    branchFanSpan: Math.PI * fanFactor,
    routeGapFactor,
    radiusExpansion,
    ringCountsByDepth: nodeDensity.countsByDepth,
    maxDensityDepth: nodeDensity.maxDepth,
    totalPressure,
    incidentPressureByNode
  };
}

function graphNodeDensityProfile(graph, normalNodeIds) {
  const normalCount = Math.max(1, normalNodeIds?.size || 0);
  const byDepth = new Map();

  for (const node of graph.nodes || []) {
    if (!node || !normalNodeIds.has(node.id)) continue;
    const depth = Math.max(0, Math.round(node.depth || 0));
    if (depth <= 0) continue;
    byDepth.set(depth, (byDepth.get(depth) || 0) + 1);
  }

  let maxRingCount = 0;
  let totalRingCount = 0;
  for (const count of byDepth.values()) {
    maxRingCount = Math.max(maxRingCount, count);
    totalRingCount += count;
  }

  return {
    normalCount,
    ringCount: byDepth.size,
    maxRingCount,
    averageRingCount: byDepth.size ? totalRingCount / byDepth.size : normalCount,
    maxDepth: Math.max(...Array.from(byDepth.keys()), 1),
    countsByDepth: byDepth
  };
}

function placeRadialChildren(parentId, depth, sectorStart, sectorEnd, parentAngle, childrenByParent, metrics, positions, branchFanSpan, spacingProfile, rootId) {
  const children = childrenByParent.get(parentId) || [];
  if (!children.length) return;

  let start = sectorStart;
  let end = sectorEnd;
  let span = Math.max(0.001, end - start);
  const parentPoint = positions.get(parentId) || { radius: 0 };
  let childRadius = parentPoint.radius + localRadialGap(parentId, depth, children, metrics, spacingProfile, rootId);
  const nodeGap = localArcGap(parentId, children, metrics, spacingProfile, rootId);

  if (children.length === 1 && parentId === rootId) {
    const localSpan = Math.max(Math.PI * 0.36, branchFanSpan * 0.82);
    start = parentAngle - localSpan / 2;
    end = parentAngle + localSpan / 2;
    span = localSpan;
  } else if (parentId !== rootId) {
    const demandSpan = children.length > 1
      ? ((children.length - 1) * nodeGap) / childRadius + 0.08
      : Math.max(Math.PI * 0.24, branchFanSpan * 0.62);
    const cappedFan = Math.min(span, branchFanSpan);
    const localSpan = Math.min(span, Math.max(cappedFan, demandSpan));
    start = parentAngle - localSpan / 2;
    end = parentAngle + localSpan / 2;
    span = localSpan;
  }

  if (children.length > 1) {
    const requiredRadius = ((children.length - 1) * nodeGap) / Math.max(0.16, span * 0.64);
    const maxExtra = spacingProfile.ringGap * (parentId === rootId ? 1.8 : 2.8);
    childRadius = Math.max(childRadius, Math.min(parentPoint.radius + maxExtra, requiredRadius));
  }

  const totalWeight = Math.max(1, children.reduce((sum, childId) => {
    const childMetrics = metrics.get(childId);
    return sum + (childMetrics ? childMetrics.weight : 1);
  }, 0));
  const localGap = children.length > 1
    ? Math.min(nodeGap / childRadius, span * 0.38 / (children.length - 1))
    : 0;
  const usableSpan = Math.max(0.001, span - localGap * Math.max(0, children.length - 1));
  let cursor = start;

  for (const childId of children) {
    const childMetrics = metrics.get(childId) || { weight: 1 };
    const childSpan = children.length === 1
      ? usableSpan
      : usableSpan * (childMetrics.weight / totalWeight);
    const childStart = cursor;
    const childEnd = cursor + childSpan;
    const childAngle = childStart + childSpan / 2;
    const radius = childRadius;
    const point = radialPoint(0, 0, radius, childAngle);

    positions.set(childId, {
      x: point.x,
      y: point.y,
      depth: depth + 1,
      angle: childAngle,
      radius,
      labelSide: labelSideForAngle(childAngle),
      centerX: 0,
      centerY: 0
    });

    placeRadialChildren(
      childId,
      depth + 1,
      childStart,
      childEnd,
      childAngle,
      childrenByParent,
      metrics,
      positions,
      branchFanSpan,
      spacingProfile,
      rootId
    );
    cursor = childEnd + localGap;
  }
}

function localRadialGap(parentId, depth, children, metrics, spacingProfile, rootId) {
  const childCount = children.length;
  const parentMetrics = metrics.get(parentId) || { count: 1, weight: 1 };
  const incidentPressure = spacingProfile.incidentPressureByNode.get(parentId) || 0;
  const childRoot = Math.sqrt(Math.max(1, childCount));
  const subtreeSignal = Math.log2(Math.max(1, parentMetrics.count || parentMetrics.weight || 1));
  const pressureSignal = Math.sqrt(Math.max(0, incidentPressure));

  let factor = 0.62
    + depth * 0.105
    + childRoot * 0.135
    + subtreeSignal * 0.094
    + pressureSignal * 0.086;

  if (parentId === rootId) factor *= 0.96;
  if (childCount <= 4) factor = Math.min(factor, parentId === rootId ? 0.94 : 1.12);
  if (childCount >= 14) factor = Math.max(factor, 1.24 + Math.min(1.1, childRoot * 0.09));
  if (childCount >= 40) factor = Math.max(factor, 1.56 + Math.min(1.34, childRoot * 0.084));

  const minGap = parentId === rootId ? 260 : 300;
  return clampNumber(spacingProfile.baseRingGap * factor, minGap, 4400, spacingProfile.baseRingGap);
}

function localArcGap(parentId, children, metrics, spacingProfile, rootId) {
  const childCount = children.length;
  const parentMetrics = metrics.get(parentId) || { count: 1, weight: 1 };
  const incidentPressure = spacingProfile.incidentPressureByNode.get(parentId) || 0;
  const densitySignal = Math.sqrt(Math.max(1, childCount)) * 0.07
    + Math.log2(Math.max(1, parentMetrics.count || 1)) * 0.052
    + Math.sqrt(Math.max(0, incidentPressure)) * 0.05;
  let factor = 1.58 + densitySignal * 1.95;

  if (parentId === rootId && childCount <= 6) factor *= 1.08;
  if (childCount <= 4) factor = clampFloat(factor, 1.62, 2.08, 1.82);
  else if (childCount <= 10) factor = Math.max(factor, 1.86);
  if (childCount >= 24) factor = Math.max(factor, 2.12);
  if (childCount >= 64) factor = Math.max(factor, 2.58);

  return clampNumber(spacingProfile.baseNodeGap * factor, 132, 920, spacingProfile.baseNodeGap);
}

function maxRadiusFromPositions(positions) {
  let maxRadius = 0;
  for (const point of positions.values()) {
    if (Number.isFinite(point.radius)) maxRadius = Math.max(maxRadius, point.radius);
  }
  return maxRadius;
}

function applyAdaptiveRadiusExpansion(positions, ringTargets, spacingProfile) {
  const expansion = clampFloat(spacingProfile?.radiusExpansion, 1, 1.65, 1);
  if (!positions || !positions.size || expansion <= 1.001) return;

  const maxDepth = Math.max(
    1,
    Number(spacingProfile?.maxDensityDepth) || 1,
    ringTargets && ringTargets.size
      ? Math.max(...Array.from(ringTargets.keys()).map(depth => Number(depth) || 0), 1)
      : 1
  );
  const ringCountsByDepth = spacingProfile?.ringCountsByDepth || new Map();
  const scaleForDepth = depth => {
    const normalizedDepth = Math.max(0, Number(depth) || 0);
    if (normalizedDepth <= 0) return 1;

    const depthRatio = clampFloat((normalizedDepth - 1) / Math.max(1, maxDepth - 1), 0, 1, 0);
    const outerWeight = Math.pow(depthRatio, 1.42);
    const ringCount = ringCountsByDepth.get(Math.round(normalizedDepth)) || 0;
    const crowdedRingBoost = Math.max(0, Math.sqrt(ringCount / 72) - 1) * 0.13 * outerWeight;
    const innerCompression = (1 - outerWeight) * Math.min(0.08, (expansion - 1) * 0.42);
    const adaptiveGrowth = (expansion - 1) * (0.04 + outerWeight * 1.06);

    return clampFloat(
      1 - innerCompression + adaptiveGrowth + crowdedRingBoost,
      0.93,
      1.68,
      1
    );
  };

  if (ringTargets && ringTargets.size) {
    for (const [depth, radius] of Array.from(ringTargets.entries())) {
      if (depth <= 0 || !Number.isFinite(radius)) continue;
      ringTargets.set(depth, radius * scaleForDepth(depth));
    }
  }

  for (const point of positions.values()) {
    if (!point || !Number.isFinite(point.radius) || point.radius <= 0.001) continue;
    const depth = Math.max(0, Math.round(point.depth || 0));
    const depthScale = scaleForDepth(depth);
    const angle = Number.isFinite(point.angle)
      ? point.angle
      : Math.atan2(point.y, point.x);
    const radius = point.radius * depthScale;
    point.radius = radius;
    point.x = Math.cos(angle) * radius;
    point.y = Math.sin(angle) * radius;
    point.angle = angle;
    point.labelSide = labelSideForAngle(angle);
    if (Number.isFinite(point.ringRadius)) point.ringRadius *= depthScale;
    if (Number.isFinite(point.ringBandMin)) point.ringBandMin *= depthScale;
    if (Number.isFinite(point.ringBandMax)) point.ringBandMax *= depthScale;
  }
}

function placeOuterCircleNodes(nodes, positions, graph, radius, nodeGap, fallbackStart, options = {}) {
  if (!nodes.length) return radius;

  const slot = (Math.PI * 2) / nodes.length;
  const crowding = nodes.length * (nodeGap / Math.max(1, radius));
  const items = nodes.map((node, index) => ({
    node,
    preferred: preferredAngleForNode(node, graph, positions, fallbackStart + index * slot)
  })).sort((a, b) => normalizeAngle(a.preferred) - normalizeAngle(b.preferred));
  const offset = items.length
    ? items[0].preferred - slot * 0.5
    : fallbackStart;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const evenAngle = offset + index * slot;
    const preferredDelta = shortestAngleDelta(evenAngle, item.preferred);
    const angle = crowding < Math.PI * 1.35
      ? evenAngle + preferredDelta * 0.55
      : evenAngle;
    const point = radialPoint(0, 0, radius, angle);

    positions.set(item.node.id, {
      x: point.x,
      y: point.y,
      depth: options.depth || item.node.depth || 1,
      angle,
      radius,
      labelSide: labelSideForAngle(angle),
      centerX: 0,
      centerY: 0,
      external: Boolean(options.external || item.node.externalProxy),
      externalGroup: Boolean(options.externalGroup),
      externalFile: Boolean(options.externalFile || item.node.externalProxy),
      fixed: Boolean(options.fixed)
    });
  }

  return radius;
}

function assignDepthRingTargets(positions, graph, spacingProfile, nodeGap) {
  const ringTargets = new Map([[0, 0]]);
  if (!positions || !positions.size) return ringTargets;

  const graphNodesById = graph.nodesById || new Map((graph.nodes || []).map(node => [node.id, node]));
  let maxLinkDegree = 1;
  for (const node of graph.nodes || []) {
    maxLinkDegree = Math.max(maxLinkDegree, (node.linkCount || 0) + (node.backlinkCount || 0));
  }

  const byDepth = new Map();
  for (const [id, point] of positions.entries()) {
    if (!point) continue;
    const depth = Math.max(0, Math.round(point.depth || 0));
    const node = graphNodesById.get(id);
    const visualRadius = node ? nodeRadius(node, point, maxLinkDegree) : 6;
    const diameter = visualRadius * 2 + Math.max(18, nodeGap * 0.36);
    if (!byDepth.has(depth)) {
      byDepth.set(depth, { count: 0, diameterTotal: 0, maxDiameter: 0, external: 0, linkPressure: 0 });
    }
    const entry = byDepth.get(depth);
    entry.count += 1;
    entry.diameterTotal += diameter;
    entry.maxDiameter = Math.max(entry.maxDiameter, diameter);
    entry.linkPressure += spacingProfile.incidentPressureByNode.get(id) || 0;
    if (point.external || node?.externalProxy || node?.type === "external") entry.external += 1;
  }

  let previousRadius = 0;
  const depths = Array.from(byDepth.keys()).filter(depth => depth > 0).sort((a, b) => a - b);
  const maxDepth = Math.max(...depths, 1);
  const totalNodes = Array.from(byDepth.values()).reduce((sum, entry) => sum + entry.count, 0);
  const globalCompression = clampFloat(1 - Math.log10(Math.max(1, totalNodes)) * 0.085, 0.58, 0.9, 0.75);
  for (const depth of depths) {
    const entry = byDepth.get(depth);
    const avgDiameter = entry.diameterTotal / Math.max(1, entry.count);
    const rawCircumferenceDemand = entry.count > 1
      ? (entry.count * avgDiameter) / (Math.PI * 2)
      : 0;
    const compressedDemand = rawCircumferenceDemand > 0
      ? Math.pow(rawCircumferenceDemand, 0.64) * Math.pow(spacingProfile.ringGap, 0.36)
      : 0;
    const depthRatio = depth / Math.max(1, maxDepth);
    const outerExpansion = 1 + Math.pow(depthRatio, 1.35) * 0.34;
    const pressureExpansion = 1 + Math.min(0.28, Math.sqrt(entry.linkPressure / Math.max(1, entry.count)) * 0.036);
    const depthCompression = clampFloat(1 - depthRatio * 0.1, 0.84, 0.98, 0.92);
    const baseRadius = depth * spacingProfile.ringGap * globalCompression * depthCompression * outerExpansion * pressureExpansion;
    const minSeparatedRadius = previousRadius + spacingProfile.ringGap * (entry.external ? 0.54 : 0.62);
    const crowdingRadius = compressedDemand * globalCompression * outerExpansion * pressureExpansion + entry.maxDiameter * 1.45;
    const maxStepRadius = previousRadius + spacingProfile.ringGap * (entry.external ? 1.45 : 1.72) * outerExpansion;
    const radius = Math.min(
      maxStepRadius,
      Math.max(baseRadius, minSeparatedRadius, crowdingRadius)
    );
    ringTargets.set(depth, radius);
    previousRadius = radius;
  }

  for (const point of positions.values()) {
    if (!point) continue;
    const depth = Math.max(0, Math.round(point.depth || 0));
    const targetRadius = ringTargets.get(depth);
    if (!Number.isFinite(targetRadius)) continue;
    const currentAngle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
    point.ringRadius = targetRadius;
    if (depth === 0) {
      point.x = 0;
      point.y = 0;
      point.radius = 0;
      point.angle = currentAngle;
      continue;
    }
    point.x = Math.cos(currentAngle) * targetRadius;
    point.y = Math.sin(currentAngle) * targetRadius;
    point.radius = targetRadius;
    point.angle = currentAngle;
    point.labelSide = labelSideForAngle(currentAngle);
  }

  return ringTargets;
}

function resolveRadialCollisions(positions, graph, spacingProfile, nodeGap, ringTargets = new Map()) {
  if (!positions || positions.size < 2) return;

  const graphNodesById = graph.nodesById || new Map((graph.nodes || []).map(node => [node.id, node]));
  let maxLinkDegree = 1;
  for (const node of graph.nodes || []) {
    maxLinkDegree = Math.max(maxLinkDegree, (node.linkCount || 0) + (node.backlinkCount || 0));
  }

  const basePad = clampNumber(nodeGap * 1.12, 54, 280, 96);
  const items = [];
  let maxCollisionRadius = 1;

  for (const [id, point] of positions.entries()) {
    const node = graphNodesById.get(id);
    if (!node || !point) continue;

    const visualRadius = nodeRadius(node, point, maxLinkDegree) * 1.72;
    const spacingPad = Math.min(320, basePad + labelCollisionPadding(node));
    const collisionRadius = visualRadius + spacingPad;
    const depth = Math.max(0, Math.round(point.depth || 0));
    const ringRadius = Number.isFinite(point.ringRadius)
      ? point.ringRadius
      : ringTargets.get(depth);
    maxCollisionRadius = Math.max(maxCollisionRadius, collisionRadius);
    items.push({
      id,
      node,
      point,
      depth,
      visualRadius,
      collisionRadius,
      gravity: clampFloat(Math.sqrt(Math.max(1, visualRadius)) / 3.1, 0.85, 2.55, 1),
      fixed: id === graph.rootId || Boolean(point.fixed),
      anchorX: point.x,
      anchorY: point.y,
      anchorRadius: Number.isFinite(point.radius) ? point.radius : Math.hypot(point.x, point.y),
      anchorAngle: Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x),
      ringRadius: Number.isFinite(ringRadius) ? ringRadius : null
    });
  }

  if (items.length < 2) return;

  const iterations = items.length > 3500 ? 9 : items.length > 1200 ? 11 : 16;
  const cellSize = Math.max(112, maxCollisionRadius * 2.48);
  const separateItems = (strength, softRepel = 0.16) => {
    let moved = false;
    const grid = new Map();

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const gx = Math.floor(item.point.x / cellSize);
      const gy = Math.floor(item.point.y / cellSize);
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(index);
    }

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const gx = Math.floor(item.point.x / cellSize);
      const gy = Math.floor(item.point.y / cellSize);

      for (let x = gx - 1; x <= gx + 1; x += 1) {
        for (let y = gy - 1; y <= gy + 1; y += 1) {
          const bucket = grid.get(`${x},${y}`);
          if (!bucket) continue;

          for (const otherIndex of bucket) {
            if (otherIndex <= index) continue;
            const other = items[otherIndex];
            if (item.fixed && other.fixed) continue;

            let dx = item.point.x - other.point.x;
            let dy = item.point.y - other.point.y;
            let distance = Math.hypot(dx, dy);

            if (distance < 0.001) {
              const angle = deterministicPairAngle(item.id, other.id);
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              distance = 1;
            }

            const minDistance = item.collisionRadius + other.collisionRadius;
            const gravity = Math.sqrt(item.gravity * other.gravity);
            const softDistance = minDistance + (item.visualRadius + other.visualRadius) * 1.75 * gravity;
            if (distance >= softDistance) continue;

            const overlapPush = distance < minDistance
              ? (minDistance - distance) * strength
              : 0;
            const softPush = distance >= minDistance
              ? (softDistance - distance) * softRepel
              : (softDistance - minDistance) * softRepel * 0.35;
            const push = (overlapPush + softPush) * gravity + 0.01;
            const nx = dx / distance;
            const ny = dy / distance;
            const itemShare = item.fixed ? 0 : other.fixed ? 1 : 0.5;
            const otherShare = other.fixed ? 0 : item.fixed ? 1 : 0.5;

            item.point.x += nx * push * itemShare;
            item.point.y += ny * push * itemShare;
            other.point.x -= nx * push * otherShare;
            other.point.y -= ny * push * otherShare;
            moved = true;
          }
        }
      }
    }
    return moved;
  };
  const pullItemsToRings = strength => {
    for (const item of items) {
      if (item.fixed || !Number.isFinite(item.ringRadius)) continue;
      const currentRadius = Math.max(0.001, Math.hypot(item.point.x, item.point.y));
      const currentAngle = Math.atan2(item.point.y, item.point.x);
      const external = item.node.externalProxy || item.node.type === "external";
      const anglePull = external ? 0.016 : 0.024;
      const ringTolerance = Math.max(
        item.visualRadius * (external ? 1.9 : 1.45),
        spacingProfile.ringGap * (external ? 0.15 : 0.105)
      );
      const nextAngle = currentAngle + shortestAngleDelta(currentAngle, item.anchorAngle) * anglePull;
      const pulledRadius = currentRadius + (item.ringRadius - currentRadius) * strength;
      const nextRadius = clampFloat(
        pulledRadius,
        Math.max(0, item.ringRadius - ringTolerance),
        item.ringRadius + ringTolerance,
        item.ringRadius
      );
      item.point.x = Math.cos(nextAngle) * nextRadius;
      item.point.y = Math.sin(nextAngle) * nextRadius;
    }
  };

  for (let pass = 0; pass < iterations; pass += 1) {
    separateItems(pass === 0 ? 0.9 : 0.72, pass < 3 ? 0.22 : 0.13);
    pullItemsToRings(pass < 3 ? 0.42 : 0.28);
  }

  for (let finalPass = 0; finalPass < 5; finalPass += 1) {
    pullItemsToRings(finalPass === 0 ? 0.18 : 0.1);
    if (!separateItems(finalPass === 0 ? 1 : 0.82, 0.05)) break;
  }

  for (const item of items) {
    const radius = Math.hypot(item.point.x, item.point.y);
    if (radius < 0.001) continue;
    item.point.radius = radius;
    item.point.angle = Math.atan2(item.point.y, item.point.x);
    item.point.labelSide = labelSideForAngle(item.point.angle);
  }
}

function enforceDepthRingBands(positions, graph, spacingProfile, nodeGap, ringTargets = new Map()) {
  if (!positions || positions.size < 2) return;

  const graphNodesById = graph.nodesById || new Map((graph.nodes || []).map(node => [node.id, node]));
  let maxLinkDegree = 1;
  for (const node of graph.nodes || []) {
    maxLinkDegree = Math.max(maxLinkDegree, (node.linkCount || 0) + (node.backlinkCount || 0));
  }

  const byDepth = new Map();
  for (const [id, point] of positions.entries()) {
    const node = graphNodesById.get(id);
    if (!node || !point) continue;

    const depth = Math.max(0, Math.round(point.depth || 0));
    if (depth === 0) {
      point.x = 0;
      point.y = 0;
      point.radius = 0;
      point.angle = -Math.PI / 2;
      continue;
    }

    const visualRadius = nodeRadius(node, point, maxLinkDegree);
    const labelDemand = labelCollisionPadding(node)
      + labelArcPadding(node) * clampFloat(0.58 + Math.min(1, depth / 4) * 0.42, 0.58, 1, 0.72);
    const arcDemand = visualRadius * 2.75 + labelDemand * 2.7 + Math.max(22, nodeGap * 0.22);
    const currentAngle = normalizeAngle(Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x));
    const parentPoint = node.parentId !== null && node.parentId !== undefined
      ? positions.get(node.parentId)
      : null;
    const parentAngle = parentPoint && Number.isFinite(parentPoint.angle)
      ? normalizeAngle(parentPoint.angle)
      : currentAngle;
    const preferred = parentPoint
      ? blendAngles(currentAngle, parentAngle, 0.68)
      : currentAngle;
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push({
      id,
      node,
      point,
      depth,
      parentId: node.parentId,
      parentAngle,
      visualRadius,
      arcDemand,
      preferred
    });
  }

  let previousOuterRadius = 0;
  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
  const maxDepth = Math.max(...depths, 1);
  for (const depth of depths) {
    const items = byDepth.get(depth);
    if (!items || !items.length) continue;

    const totalArcDemand = items.reduce((sum, item) => sum + item.arcDemand, 0);
    const maxVisualRadius = Math.max(...items.map(item => item.visualRadius), 4);
    const baseTarget = Number.isFinite(ringTargets.get(depth))
      ? ringTargets.get(depth)
      : Math.max(spacingProfile.ringGap * depth, previousOuterRadius + spacingProfile.ringGap * 0.62);
    const depthRatio = clampFloat((depth - 1) / Math.max(1, maxDepth - 1), 0, 1, 0);
    const outerDensity = Math.pow(depthRatio, 1.35);
    const laneUtilization = clampFloat(0.72 - outerDensity * 0.16 - Math.min(0.1, items.length / 4200), 0.5, 0.72, 0.62);
    const baseCapacity = Math.max(1, Math.PI * 2 * baseTarget * laneUtilization);
    const maxLaneCount = outerRingLaneLimit(items.length, depthRatio);
    const laneCount = clampNumber(
      Math.ceil(totalArcDemand / baseCapacity),
      1,
      maxLaneCount,
      1
    );
    const laneGap = Math.max(
      maxVisualRadius * (2.45 + outerDensity * 0.7) + Math.max(12, nodeGap * (0.13 + outerDensity * 0.04)),
      spacingProfile.ringGap * (0.11 + outerDensity * 0.045)
    );
    const depthJaggedFactor = ringJaggedDepthFactor(depth, baseTarget, spacingProfile.ringGap, items.length, totalArcDemand);
    const firstLaneRadius = Math.max(
      baseTarget - laneGap * (laneCount - 1) * 0.5,
      previousOuterRadius + laneGap * 0.86
    );
    const lanes = Array.from({ length: laneCount }, () => []);
    const orderedGroups = orderRingGroupsByParent(items);
    for (const group of orderedGroups) {
      const groupItems = orderRingItemsByPreferredGap(group.items);
      if (laneCount === 1) {
        lanes[0].push(...groupItems);
        continue;
      }

      const laneIndex = chooseRingLaneForGroup(lanes, groupItems, group.parentAngle);
      lanes[laneIndex].push(...groupItems);
    }

    const laneRadii = [];
    const laneOuterRadii = [];
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      const laneItems = orderRingItemsByParentThenPreferred(lanes[laneIndex]);
      if (!laneItems.length) continue;

      let laneRadius = firstLaneRadius + laneIndex * laneGap;
      const laneArcDemand = laneItems.reduce((sum, item) => sum + item.arcDemand, 0);
      const requiredRadius = laneArcDemand / (Math.PI * 2 * laneUtilization);
      laneRadius = Math.max(laneRadius, requiredRadius, previousOuterRadius + laneGap * 0.72);
      const laneJaggedFactor = depthJaggedFactor * ringJaggedDensityFactor(
        laneItems.length,
        countRingParents(laneItems),
        laneArcDemand,
        laneRadius
      );
      const candidateJitterBand = Math.min(
        spacingProfile.ringGap * RING_JAGGED_BAND_FACTOR * laneJaggedFactor,
        laneRadius * RING_JAGGED_MAX_FACTOR * Math.min(1.35, laneJaggedFactor)
      );
      laneRadius = Math.max(laneRadius, previousOuterRadius + candidateJitterBand * 0.56 + laneGap * 0.68);
      const jitterBand = Math.min(
        candidateJitterBand,
        Math.max(0, laneRadius - previousOuterRadius - maxVisualRadius * 2.2 - Math.max(12, nodeGap * 0.08))
      );
      const laneOccupancy = laneArcDemand / Math.max(1, Math.PI * 2 * laneRadius);
      placeItemsOnRingLane(laneItems, laneRadius, {
        jitterBand,
        preservePreferred: laneItems.length < 90 || laneOccupancy < 0.38 || outerDensity < 0.28
      });
      laneRadii.push(laneRadius);
      laneOuterRadii.push(laneRadius + jitterBand);
    }

    if (laneRadii.length) {
      const ringRadius = medianNumber(laneRadii, baseTarget);
      ringTargets.set(depth, ringRadius);
      previousOuterRadius = Math.max(...laneOuterRadii) + maxVisualRadius * 1.55 + Math.max(12, nodeGap * 0.08);
    }
  }
}

function orderRingItemsByPreferredGap(items) {
  const sorted = (items || [])
    .slice()
    .sort((a, b) => normalizeAngle(a.preferred) - normalizeAngle(b.preferred));
  if (sorted.length <= 2) return sorted;

  let largestGap = -1;
  let largestGapIndex = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const current = normalizeAngle(sorted[index].preferred);
    const next = normalizeAngle(sorted[(index + 1) % sorted.length].preferred) + (index === sorted.length - 1 ? Math.PI * 2 : 0);
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }

  const start = (largestGapIndex + 1) % sorted.length;
  return sorted.slice(start).concat(sorted.slice(0, start));
}

function outerRingLaneLimit(itemCount, depthRatio) {
  const count = Math.max(0, Number(itemCount) || 0);
  const outer = clampFloat(depthRatio, 0, 1, 0);
  const base = count > 1600
    ? 14
    : count > 900
      ? 12
      : count > 420
        ? 10
        : count > 180
          ? 8
          : count > 80
            ? 6
            : 4;
  const outerBonus = outer > 0.72
    ? 3
    : outer > 0.48
      ? 2
      : outer > 0.28
        ? 1
        : 0;
  return clampNumber(base + outerBonus, 4, 16, 6);
}

function orderRingGroupsByParent(items) {
  const groupsByParent = new Map();
  for (const item of items || []) {
    const key = item.parentId === null || item.parentId === undefined ? item.id : item.parentId;
    if (!groupsByParent.has(key)) {
      groupsByParent.set(key, {
        parentId: key,
        parentAngle: item.parentAngle,
        arcDemand: 0,
        items: []
      });
    }
    const group = groupsByParent.get(key);
    group.items.push(item);
    group.arcDemand += item.arcDemand || 0;
    group.parentAngle = averageAngles(group.items.map(child => child.parentAngle), group.parentAngle);
  }

  return Array.from(groupsByParent.values())
    .sort((a, b) => normalizeAngle(a.parentAngle) - normalizeAngle(b.parentAngle));
}

function chooseRingLaneForGroup(lanes, groupItems, parentAngle) {
  let bestIndex = 0;
  let bestScore = Infinity;
  const groupArc = groupItems.reduce((sum, item) => sum + (item.arcDemand || 0), 0);

  for (let index = 0; index < lanes.length; index += 1) {
    const lane = lanes[index];
    const laneArc = lane.reduce((sum, item) => sum + (item.arcDemand || 0), 0);
    const last = lane[lane.length - 1];
    const angleCost = last
      ? Math.abs(shortestAngleDelta(last.parentAngle || last.preferred, parentAngle))
      : 0;
    const score = laneArc + groupArc * 0.18 + angleCost * 180;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function orderRingItemsByParentThenPreferred(items) {
  const groups = orderRingGroupsByParent(items);
  const ordered = [];
  for (const group of groups) {
    ordered.push(...orderRingItemsByPreferredGap(group.items));
  }
  return ordered;
}

function placeItemsOnRingLane(items, radius, options = {}) {
  if (!items.length || !Number.isFinite(radius) || radius <= 0) return;

  const fullCircle = Math.PI * 2;
  const arcs = items.map(item => Math.max(0.003, item.arcDemand / radius));
  const totalArc = arcs.reduce((sum, arc) => sum + arc, 0);
  const jitterBand = clampFloat(options.jitterBand, 0, Math.max(0, radius * RING_JAGGED_MAX_FACTOR), 0);
  const parentOffsets = parentRadialOffsetsForLane(items, jitterBand);
  const minGap = Math.min(0.11, Math.max(0.012, (totalArc / Math.max(1, items.length)) * 0.18));
  const minDemand = totalArc + minGap * Math.max(0, items.length - 1);
  const preservePreferred = options.preservePreferred !== false;
  const canPreservePreferred = preservePreferred && items.length <= 640 && minDemand < fullCircle * 0.9;

  if (canPreservePreferred && placeItemsNearPreferredAngles(items, arcs, radius, jitterBand, parentOffsets, minGap)) {
    return;
  }

  const extraGap = Math.max(0, (fullCircle - totalArc) / items.length);
  let cursor = normalizeAngle(items[0].preferred) - (arcs[0] + extraGap) * 0.5;
  for (let index = 0; index < items.length; index += 1) {
    const width = arcs[index] + extraGap;
    const angle = cursor + width * 0.5;
    setRingLanePoint(items[index], radius, angle, jitterBand, parentOffsets);
    cursor += width;
  }
}

function placeItemsNearPreferredAngles(items, arcs, radius, jitterBand, parentOffsets, minGap) {
  if (!items.length) return true;
  const fullCircle = Math.PI * 2;
  const entries = items.map((item, index) => ({
    item,
    arc: arcs[index],
    preferred: normalizeAngle(Number.isFinite(item.preferred) ? item.preferred : item.parentAngle || 0)
  })).sort((a, b) => a.preferred - b.preferred);

  if (entries.length > 1) {
    let largestGap = -1;
    let largestGapIndex = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const current = entries[index].preferred;
      const next = entries[(index + 1) % entries.length].preferred + (index === entries.length - 1 ? fullCircle : 0);
      const gap = next - current;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }
    const start = (largestGapIndex + 1) % entries.length;
    const rotated = entries.slice(start).concat(entries.slice(0, start));
    entries.splice(0, entries.length, ...rotated);
  }

  const angles = [];
  let wrapOffset = 0;
  let previous = entries[0].preferred;
  angles[0] = previous;
  for (let index = 1; index < entries.length; index += 1) {
    let angle = entries[index].preferred + wrapOffset;
    while (angle <= previous) {
      wrapOffset += fullCircle;
      angle = entries[index].preferred + wrapOffset;
    }
    angles[index] = angle;
    previous = angle;
  }

  const preferredCenter = (angles[0] + angles[angles.length - 1]) * 0.5;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let index = 1; index < entries.length; index += 1) {
      const minDelta = (entries[index - 1].arc + entries[index].arc) * 0.5 + minGap;
      if (angles[index] - angles[index - 1] < minDelta) {
        angles[index] = angles[index - 1] + minDelta;
      }
    }
  }

  const span = angles[angles.length - 1] + entries[entries.length - 1].arc * 0.5
    - (angles[0] - entries[0].arc * 0.5);
  if (span > fullCircle - minGap) return false;

  const currentCenter = (angles[0] + angles[angles.length - 1]) * 0.5;
  const centerShift = preferredCenter - currentCenter;
  for (let index = 0; index < entries.length; index += 1) {
    setRingLanePoint(entries[index].item, radius, normalizeAngle(angles[index] + centerShift), jitterBand, parentOffsets);
  }
  return true;
}

function setRingLanePoint(item, radius, angle, jitterBand, parentOffsets) {
  const actualRadius = jaggedRingRadius(item, radius, jitterBand, parentOffsets);
  const point = item.point;
  point.x = Math.cos(angle) * actualRadius;
  point.y = Math.sin(angle) * actualRadius;
  point.radius = actualRadius;
  point.ringRadius = radius;
  point.ringBandMin = radius - jitterBand;
  point.ringBandMax = radius + jitterBand;
  point.angle = angle;
  point.labelSide = labelSideForAngle(angle);
}

function parentRadialOffsetsForLane(items, jitterBand) {
  const offsets = new Map();
  if (!Array.isArray(items) || !items.length || !Number.isFinite(jitterBand) || jitterBand <= 0) return offsets;

  const parentOrder = [];
  const seen = new Set();
  for (const item of items) {
    const key = ringParentKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    parentOrder.push(key);
  }

  const lanePattern = [0, -0.96, 0.96, -0.54, 0.54, -0.78, 0.78, -0.28, 0.28];
  for (let index = 0; index < parentOrder.length; index += 1) {
    const key = parentOrder[index];
    const base = lanePattern[index % lanePattern.length];
    const variation = deterministicUnitOffset(key, "ring-parent-variation") * 0.12;
    offsets.set(key, clampFloat(base + variation, -1, 1, 0) * jitterBand);
  }

  return offsets;
}

function ringJaggedDepthFactor(depth, radius, ringGap, itemCount, arcDemand) {
  const normalizedDepth = Math.max(0, Number(depth) || 0);
  const normalizedRadius = Number.isFinite(radius) && Number.isFinite(ringGap) && ringGap > 0
    ? radius / ringGap
    : normalizedDepth;
  const occupancy = Number.isFinite(radius) && radius > 0
    ? arcDemand / Math.max(1, Math.PI * 2 * radius)
    : 0;
  const outerFactor = clampFloat(0.82 + normalizedDepth * 0.06 + Math.sqrt(Math.max(0, normalizedRadius)) * 0.13, 0.86, 1.62, 1);
  const densityFactor = itemCount <= 5
    ? 0.48
    : itemCount <= 10
      ? 0.68
      : occupancy < 0.12
        ? 0.62
        : occupancy < 0.24
          ? 0.82
          : occupancy > 0.52
            ? 1.16
            : 1;
  return clampFloat(outerFactor * densityFactor, 0.42, 1.72, 1);
}

function ringJaggedDensityFactor(itemCount, parentCount, arcDemand, radius) {
  const count = Math.max(0, Number(itemCount) || 0);
  const parents = Math.max(1, Number(parentCount) || 1);
  const occupancy = Number.isFinite(radius) && radius > 0
    ? arcDemand / Math.max(1, Math.PI * 2 * radius)
    : 0;
  const childFactor = count <= 3
    ? 0.42
    : count <= 7
      ? 0.66
      : count <= 14
        ? 0.86
        : 1.05;
  const parentFactor = parents <= 1
    ? 0.52
    : parents <= 2
      ? 0.72
      : parents <= 4
        ? 0.92
        : 1.08;
  const occupancyFactor = occupancy < 0.1
    ? 0.56
    : occupancy < 0.2
      ? 0.78
      : occupancy > 0.55
        ? 1.14
        : 1;
  return clampFloat(childFactor * parentFactor * occupancyFactor, 0.32, 1.22, 1);
}

function countRingParents(items) {
  const parents = new Set();
  for (const item of items || []) {
    parents.add(ringParentKey(item));
  }
  return parents.size;
}

function jaggedRingRadius(item, radius, jitterBand, parentOffsets = null) {
  if (!item || !Number.isFinite(jitterBand) || jitterBand <= 0) return radius;
  const parentKey = ringParentKey(item);
  const parentOffset = parentOffsets && parentOffsets.has(parentKey)
    ? parentOffsets.get(parentKey)
    : deterministicUnitOffset(parentKey, "ring-parent") * jitterBand * 0.92;
  const childOffset = deterministicUnitOffset(item.id, "ring-node") * jitterBand * 0.08;
  return radius + clampFloat(parentOffset + childOffset, -jitterBand, jitterBand, 0);
}

function ringParentKey(item) {
  return item && item.parentId !== null && item.parentId !== undefined ? item.parentId : item?.id;
}

function blendAngles(from, to, amount) {
  return normalizeAngle(from + shortestAngleDelta(from, to) * clampFloat(amount, 0, 1, 0.5));
}

function labelCollisionPadding(node) {
  const titleLength = Array.from(String(node.title || "")).length;
  const typePad = node.type === "folder" ? 13 : node.type === "external" || node.externalProxy ? 9 : 5;
  return clampNumber(Math.sqrt(Math.max(1, titleLength)) * 4.2 + typePad, 10, 60, 16);
}

function labelArcPadding(node) {
  const titleLength = Array.from(String(node.title || "")).length;
  const folderPad = node.type === "folder" ? 14 : 0;
  const externalPad = node.type === "external" || node.externalProxy ? 9 : 0;
  return clampNumber(
    Math.sqrt(Math.max(1, titleLength)) * 7.5 + Math.min(110, titleLength * 1.25) + folderPad + externalPad,
    24,
    150,
    48
  );
}

function deterministicPairAngle(a, b) {
  const text = `${a}|${b}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

function deterministicUnitOffset(value, salt) {
  return Math.sin(deterministicPairAngle(String(value || ""), String(salt || "")));
}

function preferredAngleForNode(node, graph, positions, fallbackAngle) {
  const angles = [];

  if (node.externalParentId && positions.has(node.externalParentId)) {
    angles.push(positions.get(node.externalParentId).angle);
  }

  for (const edge of graph.linkEdges || []) {
    const otherId = relatedEndpointForNode(node, edge, graph);
    if (!otherId) continue;
    const otherPoint = positions.get(otherId);
    if (otherPoint && Number.isFinite(otherPoint.angle)) {
      angles.push(otherPoint.angle);
    }
  }

  return averageAngles(angles, fallbackAngle);
}

function relatedEndpointForNode(node, edge, graph) {
  if (edge.source === node.id) return edge.target;
  if (edge.target === node.id) return edge.source;

  const nodesById = graph.nodesById;
  const sourceNode = nodesById && nodesById.get(edge.source);
  const targetNode = nodesById && nodesById.get(edge.target);
  if (sourceNode && sourceNode.externalParentId === node.id) return edge.target;
  if (targetNode && targetNode.externalParentId === node.id) return edge.source;
  return null;
}

function averageAngles(angles, fallbackAngle) {
  if (!angles.length) return fallbackAngle;
  const sum = angles.reduce((acc, angle) => {
    acc.x += Math.cos(angle);
    acc.y += Math.sin(angle);
    return acc;
  }, { x: 0, y: 0 });
  if (Math.abs(sum.x) < 0.0001 && Math.abs(sum.y) < 0.0001) return fallbackAngle;
  return Math.atan2(sum.y, sum.x);
}

function radialLayoutBounds(positions, routeMaxRadius) {
  let minX = -Math.max(1, routeMaxRadius || 1);
  let minY = -Math.max(1, routeMaxRadius || 1);
  let maxX = Math.max(1, routeMaxRadius || 1);
  let maxY = Math.max(1, routeMaxRadius || 1);

  for (const point of positions.values()) {
    const labelPadX = 170;
    const labelPadTop = 46;
    const labelPadBottom = 126;
    minX = Math.min(minX, point.x - labelPadX);
    minY = Math.min(minY, point.y - labelPadTop);
    maxX = Math.max(maxX, point.x + labelPadX);
    maxY = Math.max(maxY, point.y + labelPadBottom);
  }

  return { minX, minY, maxX, maxY };
}

function shiftRadialLayout(positions, routes, offsetX, offsetY) {
  for (const point of positions.values()) {
    point.x += offsetX;
    point.y += offsetY;
    point.centerX = offsetX;
    point.centerY = offsetY;
  }

  for (const route of routes.values()) {
    if (!Number.isFinite(route.centerX) || !Number.isFinite(route.centerY)) continue;
    route.centerX += offsetX;
    route.centerY += offsetY;
  }
}

function anchorLayoutHomePositions(positions) {
  for (const point of positions.values()) {
    if (!point) continue;
    point.homeX = point.x;
    point.homeY = point.y;
    point.homeRadius = point.radius;
    point.homeAngle = point.angle;
  }
}

function applyRadialSwirl(positions, graph, spacingProfile, strength) {
  const amount = clampFloat(strength, 0, 1, 0);
  if (!positions || !positions.size || amount <= 0.001) return;

  const ringGap = Math.max(1, Number(spacingProfile?.ringGap) || DEFAULT_RING_SPACING);
  const rootId = graph?.rootId || ROOT_ID;
  const direction = deterministicUnitOffset(rootId || "vault", "swirl-direction") >= 0 ? 1 : -1;

  for (const [id, point] of positions.entries()) {
    if (!point || !Number.isFinite(point.radius) || point.radius <= 0.001) continue;

    const depth = Math.max(0, Number(point.depth) || 0);
    const baseAngle = Number.isFinite(point.angle)
      ? point.angle
      : Math.atan2(point.y, point.x);
    const radialPhase = Math.sqrt(Math.max(0, point.radius) / ringGap);
    const armVariation = deterministicUnitOffset(id, "swirl-arm") * 0.16;
    const wave = Math.sin(baseAngle * 2.35 + depth * 0.78) * 0.11;
    const turn = direction * amount * (depth * 0.32 + radialPhase * 0.22 + armVariation + wave);
    const angle = normalizeAngle(baseAngle + turn);

    point.x = Math.cos(angle) * point.radius;
    point.y = Math.sin(angle) * point.radius;
    point.angle = angle;
    point.swirlOffset = turn;
    point.labelSide = labelSideForAngle(angle);
  }
}

function computeLayoutRings(positions, ringTargets = null) {
  if (ringTargets && ringTargets.size) {
    const ringsByKey = new Map();
    for (const point of positions.values()) {
      if (!point || !Number.isFinite(point.depth) || point.depth <= 0) continue;
      const depth = Math.max(0, Math.round(point.depth || 0));
      const radius = Number.isFinite(point.ringRadius)
        ? point.ringRadius
        : ringTargets.get(depth);
      if (!Number.isFinite(radius) || radius <= 0) continue;
      const key = `${depth}:${Math.round(radius)}`;
      const existing = ringsByKey.get(key);
      if (existing) {
        existing.count += 1;
        existing.radiusTotal += radius;
      } else {
        ringsByKey.set(key, {
          depth,
          radiusTotal: radius,
          count: 1
        });
      }
    }
    return Array.from(ringsByKey.values())
      .map(ring => ({
        depth: ring.depth,
        radius: ring.radiusTotal / Math.max(1, ring.count),
        count: ring.count
      }))
      .sort((a, b) => a.radius - b.radius);
  }

  const byDepth = new Map();
  for (const point of positions.values()) {
    if (!point || !Number.isFinite(point.depth) || point.depth <= 0) continue;
    if (!Number.isFinite(point.radius) || point.radius <= 0) continue;
    if (!byDepth.has(point.depth)) byDepth.set(point.depth, []);
    byDepth.get(point.depth).push(point.radius);
  }

  return Array.from(byDepth.entries())
    .map(([depth, radii]) => {
      const sorted = radii.slice().sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
      return { depth, radius: median, count: sorted.length };
    })
    .filter(ring => ring.count >= 2)
    .sort((a, b) => a.depth - b.depth);
}

function radialPoint(centerX, centerY, radius, angle) {
  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius
  };
}

function drawCanvasRingPath(ctx, centerX, centerY, radius, depth = 0, swirlStrength = 0, orbitPhase = 0) {
  const strength = clampFloat(swirlStrength, 0, 1, 0);
  if (strength <= 0.001) {
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    return;
  }

  const fullCircle = Math.PI * 2;
  const steps = 180;
  const amplitude = Math.min(radius * 0.045, 58) * strength;
  const phase = depth * 0.74 + strength * 0.9 + orbitPhase;

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const angle = t * fullCircle;
    const twist = Math.sin(angle - phase) * 0.08 * strength;
    const ripple = Math.sin(angle * 2 + phase) * amplitude
      + Math.sin(angle * 5 - phase * 0.7) * amplitude * 0.26;
    const r = Math.max(1, radius + ripple);
    const x = centerX + Math.cos(angle + twist) * r;
    const y = centerY + Math.sin(angle + twist) * r;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function swirlOrbitAngleForRing(depth, radius, strength, elapsedSeconds) {
  const amount = clampFloat(strength, 0, 1, 0);
  if (amount <= 0.001 || depth <= 0 || !Number.isFinite(elapsedSeconds)) return 0;

  const depthIndex = Math.max(1, Math.round(depth));
  const direction = Math.floor((depthIndex - 1) / 2) % 2 === 0 ? 1 : -1;
  const outerSlowdown = clampFloat(1 / Math.sqrt(1 + Math.max(0, depthIndex - 1) * 0.24), 0.46, 1, 1);
  const radiusSlowdown = Number.isFinite(radius) && radius > 0
    ? clampFloat(Math.sqrt(DEFAULT_RING_SPACING / Math.max(DEFAULT_RING_SPACING, radius)), 0.56, 1, 1)
    : 1;
  const subtleVariation = 0.86 + Math.sin(depthIndex * 1.17) * 0.1 + Math.cos(depthIndex * 0.53) * 0.045;
  const speed = SWIRL_BASE_SPEED_RAD_PER_SEC * amount * outerSlowdown * radiusSlowdown * subtleVariation;
  return direction * speed * elapsedSeconds;
}

function labelSideForAngle(angle) {
  return Math.cos(angle) < -0.18 ? -1 : 1;
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function shortestAngleDelta(from, to) {
  const full = Math.PI * 2;
  return ((to - from + Math.PI) % full + full) % full - Math.PI;
}

function compareNodes(a, b) {
  if (!a || !b) return 0;
  if (a.type !== b.type) {
    const order = { folder: 0, note: 1, external: 2, unresolved: 3 };
    return (order[a.type] || 9) - (order[b.type] || 9);
  }
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

function normalizeSettings(saved) {
  const source = saved && typeof saved === "object" ? saved : {};
  const settings = Object.assign({}, DEFAULT_SETTINGS, source);
  const hasLegacyBudget = source.atlasDepth === LEGACY_DEFAULT_SETTINGS.atlasDepth
    && source.linkLimit === LEGACY_DEFAULT_SETTINGS.linkLimit
    && source.renderNodeLimit === LEGACY_DEFAULT_SETTINGS.renderNodeLimit;

  if (hasLegacyBudget) {
    settings.atlasDepth = DEFAULT_SETTINGS.atlasDepth;
    settings.focusSiblingLimit = DEFAULT_SETTINGS.focusSiblingLimit;
    settings.linkLimit = DEFAULT_SETTINGS.linkLimit;
    settings.renderNodeLimit = DEFAULT_SETTINGS.renderNodeLimit;
    settings.externalLinkAnchorLimit = DEFAULT_SETTINGS.externalLinkAnchorLimit;
    if (source.enableLinkHover === LEGACY_DEFAULT_SETTINGS.enableLinkHover) {
      settings.enableLinkHover = DEFAULT_SETTINGS.enableLinkHover;
    }
  }

  settings.atlasDepth = clampNumber(settings.atlasDepth, 1, MAX_ATLAS_DEPTH, DEFAULT_SETTINGS.atlasDepth);
  settings.focusSiblingLimit = clampNumber(settings.focusSiblingLimit, 10, 1000, DEFAULT_SETTINGS.focusSiblingLimit);
  settings.linkLimit = clampNumber(settings.linkLimit, 0, MAX_LINK_LIMIT, DEFAULT_SETTINGS.linkLimit);
  settings.renderNodeLimit = clampNumber(settings.renderNodeLimit, 200, MAX_RENDER_NODE_LIMIT, DEFAULT_SETTINGS.renderNodeLimit);
  settings.externalLinkAnchorLimit = clampNumber(settings.externalLinkAnchorLimit, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, DEFAULT_SETTINGS.externalLinkAnchorLimit);
  settings.externalDetailMode = ["grouped", "selected", "exact"].includes(settings.externalDetailMode)
    ? settings.externalDetailMode
    : DEFAULT_SETTINGS.externalDetailMode;
  settings.colorScheme = normalizeColorScheme(settings.colorScheme);
  settings.labelVisibility = normalizeLabelVisibility(settings.labelVisibility);
  settings.hoverHighlightMode = normalizeHoverHighlightMode(
    source.hoverHighlightMode !== undefined
      ? source.hoverHighlightMode
      : settings.enableLinkHover
        ? "note-links"
        : DEFAULT_SETTINGS.hoverHighlightMode
  );
  settings.enableLinkHover = hoverHighlightsNoteLinks(settings.hoverHighlightMode);
  settings.swirlStrength = clampNumber(settings.swirlStrength, 0, MAX_SWIRL_STRENGTH, DEFAULT_SETTINGS.swirlStrength);
  const legendItemIds = new Set(LEGEND_ITEM_DEFINITIONS.map(([id]) => id));
  settings.hiddenLegendItems = Array.isArray(settings.hiddenLegendItems)
    ? settings.hiddenLegendItems.filter(id => legendItemIds.has(id))
    : DEFAULT_SETTINGS.hiddenLegendItems.slice();
  settings.ignoreFolders = Array.isArray(settings.ignoreFolders)
    ? settings.ignoreFolders.filter(Boolean)
    : DEFAULT_SETTINGS.ignoreFolders.slice();

  return settings;
}

function normalizeLabelVisibility(value) {
  const normalized = String(value || "").trim();
  return LABEL_VISIBILITY_OPTIONS.some(([optionValue]) => optionValue === normalized)
    ? normalized
    : DEFAULT_SETTINGS.labelVisibility;
}

function normalizeHoverHighlightMode(value) {
  const normalized = String(value || "").trim();
  return HOVER_HIGHLIGHT_MODE_OPTIONS.some(([optionValue]) => optionValue === normalized)
    ? normalized
    : DEFAULT_SETTINGS.hoverHighlightMode;
}

function hoverHighlightsNoteLinks(mode) {
  return normalizeHoverHighlightMode(mode) === "note-links";
}

function hoverHighlightModeLabel(mode) {
  const normalized = normalizeHoverHighlightMode(mode);
  const option = HOVER_HIGHLIGHT_MODE_OPTIONS.find(([value]) => value === normalized);
  return option ? option[1].toLowerCase() : normalized;
}

function normalizeColorScheme(value) {
  return COLOR_SCHEME_OPTIONS.includes(value) ? value : DEFAULT_SETTINGS.colorScheme;
}

function nextColorScheme(value) {
  const current = normalizeColorScheme(value);
  const index = COLOR_SCHEME_OPTIONS.indexOf(current);
  return COLOR_SCHEME_OPTIONS[(index + 1) % COLOR_SCHEME_OPTIONS.length];
}

function colorSchemeLabel(value) {
  const scheme = normalizeColorScheme(value);
  if (scheme === "day") return "Day";
  if (scheme === "night") return "Night";
  return "Auto";
}

function colorSchemeIcon(value) {
  const scheme = normalizeColorScheme(value);
  if (scheme === "day") return "sun";
  if (scheme === "night") return "moon";
  return "monitor";
}

function nodeWithinRoot(index, node, rootId) {
  if (!node) return false;
  if (rootId === ROOT_ID || rootId === null || rootId === undefined) return true;

  let current = node;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    if (current.id === rootId) return true;
    seen.add(current.id);
    current = current.parentId === null || current.parentId === undefined
      ? null
      : index.nodes.get(current.parentId);
  }
  return false;
}

function vaultRootTitle(app) {
  const name = app?.vault?.getName?.();
  return String(name || ROOT_TITLE).trim() || ROOT_TITLE;
}

function basename(path) {
  if (!path) return ROOT_TITLE;
  const parts = path.split("/");
  return parts[parts.length - 1] || ROOT_TITLE;
}

function depthOfPath(path) {
  if (!path) return 0;
  return path.split("/").filter(Boolean).length;
}

function parentPath(path) {
  const normalizedPath = normalizeVaultPath(path);
  if (!normalizedPath || !normalizedPath.includes("/")) return ROOT_ID;
  return normalizedPath.split("/").slice(0, -1).join("/");
}

function normalizeVaultPath(path) {
  const normalized = String(path || "").trim().replace(/^\/+|\/+$/g, "");
  return normalized === "." ? ROOT_ID : normalized;
}

function comparableTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\.md$/i, "")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function normalizedQuery(query) {
  return String(query || "").trim().toLowerCase();
}

function nodeMatches(node, query) {
  if (!query) return false;
  return String(node.title || "").toLowerCase().includes(query)
    || String(node.path || "").toLowerCase().includes(query);
}

function nodeRadius(node, point, maxLinkDegree = 1) {
  const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
  const degreeRatio = Math.log1p(degree) / Math.max(1, Math.log1p(maxLinkDegree || 1));
  const clampedRatio = clampFloat(degreeRatio, 0, 1, 0);
  const degreeCurve = Math.pow(clampedRatio, 0.48);
  const hubCurve = Math.pow(clampedRatio, 1.32);
  const degreeBoost = degreeCurve * 19
    + hubCurve * 20
    + Math.log2(degree + 1) * 1.35
    + Math.sqrt(degree) * 0.32;

  if (node.externalProxy) return node.type === "unresolved" ? 5.4 : Math.min(27, 5.8 + degreeBoost * 0.62);
  if (node.type === "folder") {
    const noteSignal = Math.log2((node.noteCount || node.descendantCount || 1) + 1);
    return Math.min(66, 7 + noteSignal * 1.05 + degreeBoost * 1.18);
  }
  if (node.type === "external") {
    const noteSignal = Math.log2((node.noteCount || 1) + 1);
    return Math.min(38, 5.8 + noteSignal * 0.72 + degreeBoost * 0.9);
  }
  if (node.type === "unresolved") return Math.min(16, 4.2 + degreeBoost * 0.5);
  return Math.min(58, 3.6 + degreeBoost * 1.05);
}

function nodeMetric(node) {
  if (node.externalProxy) return node.type === "unresolved" ? "outside unresolved" : "outside note";
  if (node.type === "folder") return node.representativeFile ? `${node.noteCount || 0} notes + meta` : `${node.noteCount || 0} notes`;
  if (node.type === "external") return node.noteCount ? `${node.noteCount} outside notes` : "outside";
  if (node.type === "unresolved") return "unresolved";
  const total = (node.linkCount || 0) + (node.backlinkCount || 0);
  return total ? `${total} links` : "note";
}

function assignCanvasLabelPriority(nodes, graph) {
  const scored = nodes
    .map(item => ({ item, priority: canvasLabelPriority(item, graph) }))
    .sort((a, b) => b.priority - a.priority);
  const denominator = Math.max(1, scored.length - 1);

  for (let index = 0; index < scored.length; index += 1) {
    scored[index].item.labelRank = index;
    scored[index].item.labelPriority = scored[index].priority;
    scored[index].item.labelPercentile = 1 - index / denominator;
  }
}

function canvasLabelPriority(item, graph) {
  const node = item.node || {};
  const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
  let score = Math.max(0, item.radius || 0) * 2.8
    + Math.log1p(degree) * 13
    + Math.sqrt(degree) * 1.4
    - Math.min(34, (node.depth || 0) * 3.2);

  if (graph && node.id === graph.rootId) score += 10000;
  if (graph && node.id === graph.focusId) score += 9000;
  if (item.searchMatch) score += 8000;

  if (node.type === "folder") {
    score += 32 + Math.log1p(node.noteCount || node.descendantCount || 0) * 8;
    if (node.representativeFile) score += 8;
  } else if (node.type === "note") {
    score += 10;
  } else if (node.type === "external" || node.externalProxy) {
    score -= 10;
  } else if (node.type === "unresolved") {
    score -= 22;
  }

  return score;
}

function zoomLabelStrength(item, zoom, graph) {
  if (!item || !item.node) return 0;
  if (item.searchMatch) return 1;

  const node = item.node;
  const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
  const folder = node.type === "folder";
  const external = node.type === "external" || node.externalProxy;
  const unresolved = node.type === "unresolved";
  const root = graph && node.id === graph.rootId;
  if (root) {
    return 0.68 + smoothstep(0.04, 0.2, zoom) * 0.32;
  }

  const sizeSignal = clampFloat((item.radius - 4) / 42, 0, 1, 0);
  const degreeSignal = clampFloat(Math.log1p(degree) / Math.log1p(80), 0, 1, 0);
  const nodeCount = Math.max(1, (graph?.nodes?.length || 1));
  const rank = Number.isFinite(item.labelRank) ? item.labelRank : nodeCount;
  const rankRatio = nodeCount > 1 ? rank / Math.max(1, nodeCount - 1) : 0;
  const salienceSignal = clampFloat(1 - rankRatio, 0, 1, 0);
  const leadingCount = Math.max(10, Math.min(58, Math.ceil(nodeCount * 0.05)));
  const secondaryCount = Math.max(28, Math.min(170, Math.ceil(nodeCount * 0.18)));
  const tertiaryCount = Math.max(80, Math.min(520, Math.ceil(nodeCount * 0.38)));
  const leading = rank < leadingCount;
  const secondary = rank < secondaryCount;
  const tertiary = rank < tertiaryCount;
  let threshold = 1.24 - sizeSignal * 0.64 - degreeSignal * 0.22 - salienceSignal * 0.42;

  if (leading) threshold -= 0.28;
  else if (secondary) threshold -= 0.2;
  else if (tertiary) threshold -= 0.08;
  if (folder) threshold -= node.representativeFile ? 0.18 : 0.12;
  else if (external) threshold -= 0.04;
  if (unresolved) threshold += 0.18;

  threshold = clampFloat(threshold, 0.16, 1.38, 0.96);
  const fade = smoothstep(threshold - 0.14, threshold + 0.1, zoom);
  const leadingFade = leading
    ? smoothstep(0.12, 0.38, zoom)
    : secondary
      ? smoothstep(0.22, 0.62, zoom) * 0.9
      : tertiary
        ? smoothstep(0.46, 0.96, zoom) * 0.7
        : 0;
  const largeFade = item.radius >= 24
    ? smoothstep(0.22, 0.56, zoom) * 0.96
    : item.radius >= 15
      ? smoothstep(0.42, 0.86, zoom) * 0.78
      : 0;
  const smallFade = !unresolved ? smoothstep(0.86, 1.28, zoom) * 0.82 : 0;
  const closeFade = !unresolved ? smoothstep(1.12, 1.46, zoom) * 0.98 : 0;
  return clampFloat(Math.max(fade, leadingFade, largeFade, smallFade, closeFade), 0, 1, fade);
}

function labelScreenScale(zoom) {
  const clampedZoom = clampFloat(zoom, MIN_CANVAS_ZOOM, MAX_CANVAS_ZOOM, 1);
  return 0.62 + smoothstep(0.06, 1.48, clampedZoom) * 0.88;
}

function nodeTooltip(node) {
  const type = node.externalProxy
    ? `outside ${node.type}`
    : node.type === "folder" && node.representativeFile
      ? "folder + meta file"
      : node.isRepresentativeFile
        ? "merged meta file"
        : node.type;
  return [
    node.title,
    node.path || "/",
    `type: ${type}`,
    `notes: ${node.noteCount || 0}`,
    `out: ${node.linkCount || 0}`,
    `in: ${node.backlinkCount || 0}`
  ].join("\n");
}

function isRepresentativeEdge(index, edge) {
  const source = index.nodes.get(edge.source);
  return Boolean(source && source.representativeFile === edge.target);
}

function graphNode(index, graph, id) {
  return (graph && graph.nodesById && graph.nodesById.get(id)) || index.nodes.get(id);
}

function uniqueEdgesByEndpoint(edges, endpointKey) {
  const byEndpoint = new Map();
  for (const edge of edges) {
    const endpoint = edge && edge[endpointKey];
    if (!endpoint) continue;
    const existing = byEndpoint.get(endpoint);
    if (existing) {
      existing.weight += edge.weight || 0;
      continue;
    }
    byEndpoint.set(endpoint, Object.assign({}, edge));
  }
  return Array.from(byEndpoint.values());
}

function buildBudgetChildrenByParent(nodes) {
  const childrenByParent = new Map();
  for (const node of nodes || []) {
    if (!node || node.parentId === null || node.parentId === undefined) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node.id);
  }

  const nodeById = new Map((nodes || []).map(node => [node.id, node]));
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => compareNodes(nodeById.get(a), nodeById.get(b)));
  }
  return childrenByParent;
}

function buildCanvasGraphData(index, graph, layout, query, graphSettings = DEFAULT_NATIVE_GRAPH_SETTINGS, options = {}) {
  const nodeSizeMultiplier = clampFloat(graphSettings.nodeSizeMultiplier, 0.55, 2.8, 1);
  const lineSizeMultiplier = clampFloat(graphSettings.lineSizeMultiplier, 0.35, 4, 1);
  const includeHoverLinks = options.includeHoverLinks !== false;
  const nodes = [];
  const nodesById = new Map();
  const hierarchy = [];
  const links = [];
  const hoverLinks = [];
  const searchMatchItems = [];
  const edgesByNode = new Map();
  const linkEdgesByNode = new Map();
  const hierarchyParentByNode = new Map();
  const hierarchyChildrenByNode = new Map();
  const hierarchyChildNodeIdsByNode = new Map();
  const edgesById = new Map();
  let maxLinkDegree = 1;
  for (const node of graph.nodes) {
    maxLinkDegree = Math.max(maxLinkDegree, (node.linkCount || 0) + (node.backlinkCount || 0));
  }

  for (const node of graph.nodes) {
    const point = layout.positions.get(node.id);
    if (!point) continue;
    const item = {
      node,
      point,
      renderIndex: nodes.length,
      radius: Math.max(3.5, nodeRadius(node, point, maxLinkDegree) * nodeSizeMultiplier),
      label: node.title,
      metric: nodeMetric(node),
      searchMatch: Boolean(query && nodeMatches(node, query))
    };
    nodes.push(item);
    if (item.searchMatch) searchMatchItems.push(item);
    nodesById.set(node.id, item);
  }

  for (const node of graph.nodes) {
    if (!node || node.parentId === null || node.parentId === undefined) continue;
    const childId = index.visualNodeId(node.id);
    const parentId = index.visualNodeId(node.parentId);
    if (childId === null || childId === undefined || parentId === null || parentId === undefined) continue;
    if (childId === parentId || !nodesById.has(childId) || !nodesById.has(parentId)) continue;
    if (!hierarchyChildNodeIdsByNode.has(parentId)) hierarchyChildNodeIdsByNode.set(parentId, []);
    const children = hierarchyChildNodeIdsByNode.get(parentId);
    if (!children.includes(childId)) children.push(childId);
  }

  assignCanvasLabelPriority(nodes, graph);
  const labelItems = nodes
    .slice()
    .sort((a, b) => (a.labelPriority || 0) - (b.labelPriority || 0));
  const interactiveLabelItems = labelItems.filter(item =>
    item.searchMatch
    || item.labelRank <= FAST_CANVAS_LABEL_LIMIT
    || item.node.id === graph.rootId
    || item.node.id === graph.focusId
  );

  const registerEdge = (collection, edge, sourcePoint, targetPoint, options = {}) => {
    const key = options.key || edge.id || `${edge.source}->${edge.target}`;
    const item = {
      key,
      edge,
      source: edge.source,
      target: edge.target,
      sourcePoint,
      targetPoint,
      width: options.width || 1,
      external: Boolean(options.external),
      hoverOnly: Boolean(options.hoverOnly),
      route: options.route || null
    };
    collection.push(item);
    if (edge.id) edgesById.set(edge.id, item);
    for (const id of [edge.source, edge.target]) {
      if (!id && id !== ROOT_ID) continue;
      if (!edgesByNode.has(id)) edgesByNode.set(id, []);
      edgesByNode.get(id).push(item);
      if (options.linkOverlay) {
        if (!linkEdgesByNode.has(id)) linkEdgesByNode.set(id, []);
        linkEdgesByNode.get(id).push(item);
      }
    }
    if (options.hierarchyTree) {
      hierarchyParentByNode.set(edge.target, item);
      if (!hierarchyChildrenByNode.has(edge.source)) hierarchyChildrenByNode.set(edge.source, []);
      hierarchyChildrenByNode.get(edge.source).push(item);
    }
    return item;
  };

  for (const edge of graph.hierarchyEdges) {
    const sourcePoint = layout.positions.get(edge.source);
    const targetPoint = layout.positions.get(edge.target);
    if (!sourcePoint || !targetPoint) continue;
    registerEdge(hierarchy, edge, sourcePoint, targetPoint, {
      width: edge.type === "external-hierarchy" ? 1.05 : 1.12,
      external: edge.type === "external-hierarchy",
      hierarchyTree: true
    });
  }

  for (const edge of graph.linkEdges) {
    const sourcePoint = layout.positions.get(edge.source);
    const targetPoint = layout.positions.get(edge.target);
    if (!sourcePoint || !targetPoint) continue;
    const weightSignal = Math.log2((edge.weight || 1) + 1);
    registerEdge(links, edge, sourcePoint, targetPoint, {
      width: clampFloat((0.42 + weightSignal * 0.2) * lineSizeMultiplier, 0.48, 3.4, 1),
      external: Boolean(edge.externalCount),
      linkOverlay: true,
      route: layout.linkRoutes ? layout.linkRoutes.get(edge.id) : null
    });
  }

  if (includeHoverLinks) {
    const renderedLinkKeys = new Set(links.map(item => item.key));
    for (const edge of graph.hoverLinkEdges || []) {
      const key = edge.id || `${edge.source}->${edge.target}`;
      if (renderedLinkKeys.has(key)) continue;
      const sourcePoint = layout.positions.get(edge.source);
      const targetPoint = layout.positions.get(edge.target);
      if (!sourcePoint || !targetPoint) continue;
      const weightSignal = Math.log2((edge.weight || 1) + 1);
      registerEdge(hoverLinks, edge, sourcePoint, targetPoint, {
        width: clampFloat((0.42 + weightSignal * 0.2) * lineSizeMultiplier, 0.48, 3.4, 1),
        external: Boolean(edge.externalCount),
        linkOverlay: true,
        hoverOnly: true,
        route: layout.linkRoutes ? layout.linkRoutes.get(edge.id) : null
      });
    }
  }

  return {
    nodes,
    nodesById,
    nodeSpatialIndex: buildCanvasNodeSpatialIndex(nodes),
    labelItems,
    interactiveLabelItems,
    searchMatchItems,
    hierarchy,
    links,
    hoverLinks,
    edgesByNode,
    linkEdgesByNode,
    hierarchyParentByNode,
    hierarchyChildrenByNode,
    hierarchyChildNodeIdsByNode,
    edgesById,
    showArrow: graphSettings.showArrow !== false
  };
}

function addHierarchyHoverHighlights(data, nodeId, mode, relatedNodes, highlightedEdges, labelNodes) {
  const normalized = normalizeHoverHighlightMode(mode);
  if (!data || normalized === "none" || normalized === "note-links") return;

  if (
    normalized === "hierarchy-parents"
    || normalized === "hierarchy-parents-direct"
    || normalized === "hierarchy-all"
  ) {
    addHierarchyAncestorHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes);
  }

  if (
    normalized === "hierarchy-direct-children"
    || normalized === "hierarchy-parents-direct"
  ) {
    addHierarchyChildHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes);
  }

  if (
    normalized === "hierarchy-descendants"
    || normalized === "hierarchy-all"
  ) {
    addHierarchyDescendantHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes);
  }
}

function addHierarchyAncestorHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes) {
  const parentByNode = data.hierarchyParentByNode || new Map();
  const visited = new Set([nodeId]);
  let currentId = nodeId;

  while (parentByNode.has(currentId)) {
    const edge = parentByNode.get(currentId);
    if (!edge || highlightedEdges.has(edge.key)) break;
    highlightedEdges.add(edge.key);
    addHierarchyEdgeNodes(edge, relatedNodes, labelNodes);
    currentId = edge.source;
    if (visited.has(currentId)) break;
    visited.add(currentId);
  }
}

function addHierarchyChildHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes) {
  for (const edge of data.hierarchyChildrenByNode?.get(nodeId) || []) {
    highlightedEdges.add(edge.key);
    addHierarchyEdgeNodes(edge, relatedNodes, labelNodes);
  }
  addHierarchyChildNodeIds(data, nodeId, relatedNodes, labelNodes);
}

function addHierarchyDescendantHighlights(data, nodeId, relatedNodes, highlightedEdges, labelNodes) {
  const childrenByNode = data.hierarchyChildrenByNode || new Map();
  const childIdsByNode = data.hierarchyChildNodeIdsByNode || new Map();
  const stack = [];
  const visited = new Set([nodeId]);

  pushHierarchyChildEntries(stack, childrenByNode, childIdsByNode, nodeId);

  while (stack.length) {
    const entry = stack.pop();
    if (!entry || entry.target === null || entry.target === undefined || visited.has(entry.target)) continue;
    if (entry.edge) {
      highlightedEdges.add(entry.edge.key);
      addHierarchyEdgeNodes(entry.edge, relatedNodes, labelNodes);
    } else {
      relatedNodes.add(entry.target);
      labelNodes.add(entry.target);
    }
    visited.add(entry.target);
    pushHierarchyChildEntries(stack, childrenByNode, childIdsByNode, entry.target);
  }
}

function pushHierarchyChildEntries(stack, childrenByNode, childIdsByNode, nodeId) {
  const edges = childrenByNode.get(nodeId) || [];
  const edgeTargets = new Set();
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index];
    if (!edge || edge.target === null || edge.target === undefined) continue;
    edgeTargets.add(edge.target);
    stack.push({ edge, target: edge.target });
  }

  const childIds = childIdsByNode.get(nodeId) || [];
  for (let index = childIds.length - 1; index >= 0; index -= 1) {
    const childId = childIds[index];
    if (edgeTargets.has(childId)) continue;
    stack.push({ edge: null, target: childId });
  }
}

function addHierarchyChildNodeIds(data, nodeId, relatedNodes, labelNodes) {
  for (const childId of data.hierarchyChildNodeIdsByNode?.get(nodeId) || []) {
    relatedNodes.add(childId);
    labelNodes.add(childId);
  }
}

function addHierarchyEdgeNodes(edge, relatedNodes, labelNodes) {
  if (!edge) return;
  if (edge.source !== null && edge.source !== undefined) {
    relatedNodes.add(edge.source);
    labelNodes.add(edge.source);
  }
  if (edge.target !== null && edge.target !== undefined) {
    relatedNodes.add(edge.target);
    labelNodes.add(edge.target);
  }
}

function resolveCssColor(root, variableName, fallback) {
  if (!root || !root.ownerDocument) return fallback;
  const probe = root.ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.color = `var(${variableName})`;
  root.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color || fallback;
}

function resolveGraphViewColor(root, colorClass, fallback) {
  if (!root || !root.ownerDocument) return fallback;
  const wrapper = root.ownerDocument.createElement("span");
  wrapper.style.position = "absolute";
  wrapper.style.width = "0";
  wrapper.style.height = "0";
  wrapper.style.overflow = "hidden";
  wrapper.style.pointerEvents = "none";
  wrapper.style.color = fallback;
  const probe = root.ownerDocument.createElement("span");
  probe.className = `graph-view ${colorClass}`;
  wrapper.appendChild(probe);
  root.appendChild(wrapper);
  const color = getComputedStyle(probe).color;
  wrapper.remove();
  return color || fallback;
}

function canvasWorldBounds(viewport, panX, panY, zoom, margin = 160) {
  const safeZoom = Math.max(MIN_CANVAS_ZOOM, Number(zoom) || 1);
  const minX = (0 - panX) / safeZoom - margin;
  const minY = (0 - panY) / safeZoom - margin;
  const maxX = ((viewport?.width || 1) - panX) / safeZoom + margin;
  const maxY = ((viewport?.height || 1) - panY) / safeZoom + margin;
  return { minX, minY, maxX, maxY };
}

function circleInBounds(point, radius, bounds) {
  if (!point || !bounds) return true;
  const r = Math.max(0, Number(radius) || 0);
  return point.x + r >= bounds.minX
    && point.x - r <= bounds.maxX
    && point.y + r >= bounds.minY
    && point.y - r <= bounds.maxY;
}

function buildCanvasNodeSpatialIndex(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null;

  let maxRadius = 1;
  for (const item of nodes) {
    maxRadius = Math.max(maxRadius, Number(item.radius) || 1);
  }

  const cellSize = clampFloat(maxRadius * 2.6 + 28, 56, 220, 96);
  const grid = new Map();
  for (const item of nodes) {
    if (!item || !item.point) continue;
    const gx = Math.floor(item.point.x / cellSize);
    const gy = Math.floor(item.point.y / cellSize);
    const key = `${gx},${gy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(item);
  }

  return { cellSize, grid, maxRadius };
}

function hitTestCanvasNodeIndex(data, world, nodePad) {
  const index = data && data.nodeSpatialIndex;
  if (!index || !index.grid || !Number.isFinite(index.cellSize)) {
    return hitTestCanvasNodeLinear(data, world, nodePad);
  }

  const reach = Math.max(index.maxRadius || 1, nodePad || 0) + Math.max(1, nodePad || 0);
  const span = Math.max(1, Math.ceil(reach / index.cellSize));
  const centerX = Math.floor(world.x / index.cellSize);
  const centerY = Math.floor(world.y / index.cellSize);
  let best = null;
  let bestRenderIndex = -1;

  for (let gx = centerX - span; gx <= centerX + span; gx += 1) {
    for (let gy = centerY - span; gy <= centerY + span; gy += 1) {
      const bucket = index.grid.get(`${gx},${gy}`);
      if (!bucket) continue;
      for (const item of bucket) {
        const distance = Math.hypot(world.x - item.point.x, world.y - item.point.y);
        if (distance > item.radius + nodePad) continue;
        const renderIndex = Number.isFinite(item.renderIndex) ? item.renderIndex : 0;
        if (renderIndex >= bestRenderIndex) {
          best = item;
          bestRenderIndex = renderIndex;
        }
      }
    }
  }

  return best;
}

function hitTestCanvasNodeLinear(data, world, nodePad) {
  if (!data || !Array.isArray(data.nodes)) return null;
  for (let i = data.nodes.length - 1; i >= 0; i -= 1) {
    const item = data.nodes[i];
    if (!item || !item.point) continue;
    const distance = Math.hypot(world.x - item.point.x, world.y - item.point.y);
    if (distance <= item.radius + nodePad) return item;
  }
  return null;
}

function edgeItemInBounds(item, bounds) {
  if (!item || !bounds) return true;
  const source = item.sourcePoint;
  const target = item.targetPoint;
  if (!source || !target) return true;
  const route = item.dynamicRoute || item.route;

  let minX = Math.min(source.x, target.x);
  let minY = Math.min(source.y, target.y);
  let maxX = Math.max(source.x, target.x);
  let maxY = Math.max(source.y, target.y);

  if (route && Number.isFinite(route.radius) && Number.isFinite(route.centerX) && Number.isFinite(route.centerY)) {
    minX = Math.min(minX, route.centerX - route.radius);
    minY = Math.min(minY, route.centerY - route.radius);
    maxX = Math.max(maxX, route.centerX + route.radius);
    maxY = Math.max(maxY, route.centerY + route.radius);
  } else if (route && route.kind === "curve") {
    const centerX = Number.isFinite(source.centerX) ? source.centerX : (source.x + target.x) / 2;
    const centerY = Number.isFinite(source.centerY) ? source.centerY : (source.y + target.y) / 2;
    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2;
    const pull = Number.isFinite(route.curveStrength) ? route.curveStrength : (item.external ? 0.28 : 0.16);
    const controlX = midX + (centerX - midX) * pull;
    const controlY = midY + (centerY - midY) * pull;
    minX = Math.min(minX, controlX);
    minY = Math.min(minY, controlY);
    maxX = Math.max(maxX, controlX);
    maxY = Math.max(maxY, controlY);
  }

  return maxX >= bounds.minX
    && minX <= bounds.maxX
    && maxY >= bounds.minY
    && minY <= bounds.maxY;
}

function distanceToSegment(point, source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - source.x, point.y - source.y);
  const t = Math.max(0, Math.min(1, ((point.x - source.x) * dx + (point.y - source.y) * dy) / (dx * dx + dy * dy)));
  const x = source.x + dx * t;
  const y = source.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function dynamicOrbitRouteForEdge(item, centerX, centerY, ringGap) {
  const source = item?.sourcePoint;
  const target = item?.targetPoint;
  if (!source || !target) return null;

  const sx = source.x - centerX;
  const sy = source.y - centerY;
  const tx = target.x - centerX;
  const ty = target.y - centerY;
  const sourceRadius = Math.max(1, Math.hypot(sx, sy));
  const targetRadius = Math.max(1, Math.hypot(tx, ty));
  const sourceAngle = Math.atan2(sy, sx);
  const targetAngle = Math.atan2(ty, tx);
  const delta = shortestAngleDelta(sourceAngle, targetAngle);
  const angleDistance = Math.abs(delta);
  const safeRingGap = Math.max(120, Number(ringGap) || DEFAULT_RING_SPACING);
  const external = item.external || item.edge?.externalCount;
  const sameOrNearRing = Math.abs(sourceRadius - targetRadius) < safeRingGap * 0.5;
  const laneNoise = (deterministicUnitOffset(item.key || item.edge?.id || `${item.source}->${item.target}`, "dynamic-route") + 1) * 0.5;
  const laneOffset = (0.34 + laneNoise * 0.66) * safeRingGap * (external ? 0.16 : 0.095);
  const routeRadius = Math.max(sourceRadius, targetRadius)
    + Math.max(external ? 96 : 52, safeRingGap * (external ? 0.2 : sameOrNearRing ? 0.13 : 0.09))
    + laneOffset;

  if (!external && !sameOrNearRing && angleDistance < 0.28) {
    return {
      kind: "curve",
      curveStrength: 0.12
    };
  }

  return {
    kind: "dynamic-orbit",
    centerX,
    centerY,
    radius: routeRadius,
    sourceAngle,
    targetAngle,
    endAngle: sourceAngle + delta,
    sweep: delta >= 0 ? 1 : 0
  };
}

function linkTooltip(index, edge, graph) {
  const source = graphNode(index, graph, edge.source);
  const target = graphNode(index, graph, edge.target);
  return [
    "Aggregated internal link overlay",
    `${source ? source.title : edge.source} -> ${target ? target.title : edge.target}`,
    `weight: ${edge.weight || 0}`,
    `raw edges: ${edge.rawCount || edge.weight || 0}`,
    `unresolved: ${edge.unresolvedCount || 0}`,
    `external: ${edge.externalCount || 0}`
  ].join("\n");
}

function nodeRenderScore(node, rootId, focusId, query) {
  let score = 0;
  if (node.id === rootId) score += 1000000;
  if (node.id === focusId) score += 900000;
  if (query && nodeMatches(node, query)) score += 700000;
  score += Math.max(0, 200 - node.depth * 18);

  if (node.type === "folder") {
    score += 5000 + Math.min(2500, Math.log2((node.noteCount || 0) + 1) * 280);
  } else if (node.type === "note") {
    score += 500 + Math.min(2500, Math.log2((node.linkCount || 0) + (node.backlinkCount || 0) + 1) * 420);
  } else if (node.type === "unresolved") {
    score += 80;
  }

  return score;
}

function linkRenderScore(edge) {
  return (edge.externalCount ? 100000 : 0)
    + Math.min(60000, (edge.weight || 0) * 100)
    + Math.min(10000, (edge.rawCount || 0) * 10);
}

function externalAnchorPath(node, rootId) {
  const nodePath = node.type === "unresolved" ? parentPath(node.path) : node.path;
  const pathParts = String(nodePath || "").split("/").filter(Boolean);
  if (!pathParts.length) return null;
  if (!rootId) return pathParts[0] || nodePath;

  const rootParts = String(rootId || "").split("/").filter(Boolean);
  let common = 0;
  while (
    common < rootParts.length
    && common < pathParts.length
    && rootParts[common] === pathParts[common]
  ) {
    common += 1;
  }

  const anchorLength = Math.min(pathParts.length, common + 1);
  return pathParts.slice(0, anchorLength).join("/");
}

function computeLinkRoutes(linkEdges, positions, maxDepth, ringSpacing, outerRadius, routeGapFactor = 1) {
  const routes = new Map();
  let maxRadius = Math.max(outerRadius || 0, 1);

  for (const edge of linkEdges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;

    const sourceRadius = Number.isFinite(source.radius) ? source.radius : 0;
    const targetRadius = Number.isFinite(target.radius) ? target.radius : 0;
    const sourceAngle = Number.isFinite(source.angle) ? source.angle : Math.atan2(target.y - source.y, target.x - source.x);
    const targetAngle = Number.isFinite(target.angle) ? target.angle : sourceAngle;
    const delta = shortestAngleDelta(sourceAngle, targetAngle);
    const angleDistance = Math.abs(delta);
    const sameOrNearRing = Math.abs(sourceRadius - targetRadius) < ringSpacing * 0.44;
    const touchesOuterRing = Math.max(source.depth || 0, target.depth || 0) >= Math.max(1, maxDepth - 1);
    const isExternal = Boolean(source.external || target.external || edge.externalCount);
    const shouldCurve = isExternal
      || sameOrNearRing
      || (touchesOuterRing && angleDistance > 0.34)
      || angleDistance > Math.PI * 0.42;

    if (!shouldCurve) continue;

    routes.set(edge.id, {
      kind: "curve",
      lane: 0,
      curveStrength: isExternal
        ? 0.3
        : sameOrNearRing
          ? 0.22
          : angleDistance > Math.PI * 0.72
            ? 0.2
            : 0.15
    });
  }

  return { routes, maxRadius };
}

function assignRadialLaneRoutes(items, routes, outerRadius, ringSpacing, routeGapFactor = 1) {
  const lanes = [];
  let maxRadius = outerRadius || 0;
  const sorted = items.slice().sort((a, b) => {
    if (a.interval.start !== b.interval.start) return a.interval.start - b.interval.start;
    return a.interval.end - b.interval.end;
  });

  for (const item of sorted) {
    let lane = lanes.findIndex(endAngle => item.interval.start > endAngle + 0.12);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(item.interval.end);
    } else {
      lanes[lane] = item.interval.end;
    }

    const cappedLane = Math.min(lane, 14);
    const laneStep = Math.max(18, Math.min(44, ringSpacing * 0.075 * routeGapFactor));
    const radius = Math.max(
      outerRadius || 0,
      item.source.radius || 0,
      item.target.radius || 0
    ) + (item.isExternal ? 100 : 48) * routeGapFactor + cappedLane * laneStep;
    maxRadius = Math.max(maxRadius, radius);
    routes.set(item.edge.id, {
      kind: item.isExternal ? "external" : "outer",
      lane,
      centerX: 0,
      centerY: 0,
      radius,
      sourceAngle: item.sourceAngle,
      targetAngle: item.targetAngle,
      endAngle: item.sourceAngle + item.delta,
      sweep: item.delta >= 0 ? 1 : 0
    });
  }

  return maxRadius;
}

function radialRouteInterval(sourceAngle, delta) {
  let start = normalizeAngle(sourceAngle);
  let end = start + delta;
  if (end < start) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (end - start < 0.05) end += 0.05;
  return { start, end };
}

function wrapCanvasLabel(ctx, label, maxWidth, maxLines) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text) return [];

  const words = text.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const pieces = splitCanvasWord(ctx, word, maxWidth);

    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (!current || ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      lines.push(current);
      current = piece;
    }
  }

  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;

  const clipped = lines.slice(0, Math.max(1, maxLines));
  clipped[clipped.length - 1] = fitCanvasText(ctx, clipped[clipped.length - 1], maxWidth, "...");
  return clipped;
}

function splitCanvasWord(ctx, word, maxWidth) {
  if (ctx.measureText(word).width <= maxWidth) return [word];

  const pieces = [];
  let current = "";
  for (const char of Array.from(word)) {
    const candidate = `${current}${char}`;
    if (!current || ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    pieces.push(current);
    current = char;
  }
  if (current) pieces.push(current);
  return pieces;
}

function fitCanvasText(ctx, text, maxWidth, suffix = "...") {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(String(text || ""));
  while (chars.length && ctx.measureText(`${chars.join("")}${suffix}`).width > maxWidth) {
    chars.pop();
  }
  return chars.length ? `${chars.join("")}${suffix}` : suffix;
}

function fitZoomForLayout(layout, viewport, inset = 32) {
  if (!layout || !viewport) return DEFAULT_MIN_CANVAS_ZOOM;
  const availableWidth = Math.max(1, (viewport.width || 1) - inset);
  const availableHeight = Math.max(1, (viewport.height || 1) - inset);
  return Math.min(
    availableWidth / Math.max(1, layout.width || 1),
    availableHeight / Math.max(1, layout.height || 1)
  );
}

function adaptiveMaxZoomForLayout(layout, viewport) {
  if (!layout || !viewport) return MAX_CANVAS_ZOOM;

  const fitZoom = fitZoomForLayout(layout, viewport, 42);
  const viewportMin = Math.max(1, Math.min(viewport.width || 1, viewport.height || 1));
  const nodeCount = Math.max(1, layout.positions ? layout.positions.size : 1);
  const area = Math.max(1, (layout.width || 1) * (layout.height || 1));
  const densitySpacing = Math.sqrt(area / nodeCount) * 0.58;
  const ringGap = medianRingGap(layout.rings);
  const usefulWorldWindow = clampFloat(
    Math.max(densitySpacing * 1.65, ringGap * 1.55),
    280,
    1180,
    520
  );
  const densityMax = viewportMin / usefulWorldWindow;
  const countFactor = nodeCount < 120
    ? 2.3
    : nodeCount < 700
      ? 3.35
      : nodeCount < 2400
        ? 4.45
        : 5.25;
  const fitMax = fitZoom * countFactor;
  const minAllowed = Math.min(
    MAX_CANVAS_ZOOM,
    Math.max(MIN_CANVAS_ZOOM, DEFAULT_MIN_CANVAS_ZOOM * 2.4, fitZoom * 1.22)
  );
  const proposed = Math.max(fitZoom * 1.35, densityMax, fitMax);
  return clampFloat(proposed, minAllowed, MAX_CANVAS_ZOOM, MAX_CANVAS_ZOOM);
}

function medianRingGap(rings) {
  if (!Array.isArray(rings) || !rings.length) return 420;

  const radii = rings
    .map(ring => ring && Number(ring.radius))
    .filter(radius => Number.isFinite(radius) && radius > 0)
    .sort((a, b) => a - b);
  if (!radii.length) return 420;
  if (radii.length === 1) return clampFloat(radii[0], 260, 720, 420);

  const gaps = [];
  for (let index = 1; index < radii.length; index += 1) {
    const gap = radii[index] - radii[index - 1];
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  return medianNumber(gaps, 420);
}

function medianNumber(values, fallback) {
  const numbers = (values || [])
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!numbers.length) return fallback;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function zoomToSliderValue(zoom, minZoom, maxZoom) {
  const min = Math.max(MIN_CANVAS_ZOOM, Number(minZoom) || MIN_CANVAS_ZOOM);
  const max = Math.max(min * 1.001, Number(maxZoom) || MAX_CANVAS_ZOOM);
  const clamped = clampFloat(zoom, min, max, min);
  const ratio = Math.log(clamped / min) / Math.log(max / min);
  const sliderRatio = Math.pow(clampFloat(ratio, 0, 1, 0), 1 / ZOOM_SLIDER_CURVE);
  return String(Math.round(sliderRatio * ZOOM_SLIDER_STEPS));
}

function sliderValueToZoom(value, minZoom, maxZoom) {
  const min = Math.max(MIN_CANVAS_ZOOM, Number(minZoom) || MIN_CANVAS_ZOOM);
  const max = Math.max(min * 1.001, Number(maxZoom) || MAX_CANVAS_ZOOM);
  const sliderRatio = clampFloat(Number(value) / ZOOM_SLIDER_STEPS, 0, 1, 0);
  const ratio = Math.pow(sliderRatio, ZOOM_SLIDER_CURVE);
  return min * Math.pow(max / min, ratio);
}

function truncateLabel(label, maxLength) {
  const text = String(label || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}...`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clampFloat((value - edge0) / (edge1 - edge0), 0, 1, 0);
  return t * t * (3 - 2 * t);
}

function springBackEase(value) {
  const t = clampFloat(value, 0, 1, 0);
  const c1 = 1.28;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

module.exports = MiniWorldMapPlugin;
