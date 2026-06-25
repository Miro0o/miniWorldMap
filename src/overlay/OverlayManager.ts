import type { GraphData } from '../types';
import type { AggregateRenderer } from '../render/AggregateRenderer';

/**
 * DOM labels for hub, hover, and selected-neighbor names.
 */
export class OverlayManager {
	private root: HTMLElement;
	private hubEls: { index: number; el: HTMLElement }[] = [];
	private neighborEls: { index: number; el: HTMLElement }[] = [];
	private hoverEl: HTMLElement;
	private hoverIndex = -1;
	private data: GraphData = { nodes: [], links: [] };
	private graphRadius = 200;
	private hubBudget = 14;
	private neighborBudget = 20;

	constructor(
		parent: HTMLElement,
		private renderer: AggregateRenderer,
	) {
		this.root = parent.createDiv({ cls: 'gx-overlay' });
		this.hoverEl = this.root.createDiv({ cls: 'gx-label gx-label-hover' });
		this.hoverEl.hide();
	}

	setBudgets(hub: number, neighbor: number): void {
		this.hubBudget = hub;
		this.neighborBudget = neighbor;
		this.setData(this.data, this.graphRadius);
	}

	setData(data: GraphData, graphRadius: number): void {
		this.data = data;
		this.graphRadius = graphRadius;
		for (const h of this.hubEls) h.el.remove();
		this.hubEls = [...data.nodes.entries()]
			.filter(([, n]) => !n.unresolved)
			.sort((a, b) => b[1].degree - a[1].degree)
			.slice(0, this.hubBudget)
			.map(([index, n]) => ({
				index,
				el: this.root.createDiv({ cls: 'gx-label gx-label-hub', text: n.name }),
			}));
		// 数据重建后旧索引失效，清掉依赖索引的状态
		this.setHover(-1);
		this.setSelection(-1, new Set());
	}

	setHover(index: number): void {
		this.hoverIndex = index;
		if (index < 0) {
			this.hoverEl.hide();
			return;
		}
		const node = this.data.nodes[index];
		if (!node) return;
		this.hoverEl.setText(node.name);
		this.hoverEl.show();
	}

	/** Selected node: neighbor labels only; details render in the left panel. */
	setSelection(index: number, neighbors: Set<number>): void {
		for (const e of this.neighborEls) e.el.remove();
		this.neighborEls = [];
		if (index < 0) return;
		const byDegree = [...neighbors]
			.filter((i) => i !== index)
			.sort((a, b) => (this.data.nodes[b]?.degree ?? 0) - (this.data.nodes[a]?.degree ?? 0))
			.slice(0, this.neighborBudget);
		this.neighborEls = byDegree.map((i) => ({
			index: i,
			el: this.root.createDiv({ cls: 'gx-label gx-label-neighbor', text: this.data.nodes[i]?.name ?? '' }),
		}));
	}

	/** 每帧：投影所有被追踪节点，translate3d 定位（GPU 合成，无重排） */
	update(w: number, h: number): void {
		const far = this.graphRadius * 2.6;
		const near = this.graphRadius * 1.2;
		for (const { index, el } of this.hubEls) {
			const p = this.renderer.projectNode(index, w, h);
			if (p.behind || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
				el.setCssProps({ opacity: '0' });
				continue;
			}
			const dist = this.renderer.cameraDistanceTo(index);
			const a = Math.min(Math.max((far - dist) / (far - near), 0), 1);
			el.style.opacity = a.toFixed(2);
			el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 14).toFixed(1)}px, 0)`;
		}
		for (const { index, el } of this.neighborEls) {
			const p = this.renderer.projectNode(index, w, h);
			el.style.opacity = p.behind ? '0' : '0.85';
			if (!p.behind) el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 12).toFixed(1)}px, 0)`;
		}
		if (this.hoverIndex >= 0) {
			const p = this.renderer.projectNode(this.hoverIndex, w, h);
			if (!p.behind) this.hoverEl.style.transform = `translate3d(${p.x.toFixed(1)}px, ${(p.y - 18).toFixed(1)}px, 0)`;
		}
	}

	dispose(): void {
		this.root.remove();
		this.hubEls = [];
		this.neighborEls = [];
	}
}
