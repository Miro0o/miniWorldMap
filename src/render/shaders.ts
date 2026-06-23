// Nodes are one THREE.Points draw call. Keep them close to the legacy
// canvas look: filled discs with a visible rim and only a restrained core lift.
// aDim: 聚焦模式下非邻居淡出（0.12..1）

export const NODE_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aGhost;
attribute float aDim;
varying vec3 vColor;
varying float vGhost;
varying float vDim;
uniform float uPixelScale; // drawingBufferHeight / (2·tan(fov/2))
uniform float uSizeMul; // 控制面板「节点大小」倍率
uniform float uSizeContrast;
uniform float uBasePoint;
uniform float uMinPoint;
uniform float uMaxPoint; // 设备像素钳制：穿行星团时防满屏大精灵打爆填充率（M3）

void main() {
	vColor = color;
	vGhost = aGhost;
	vDim = aDim;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	float localSize = max(uBasePoint, uBasePoint + max(aSize - uBasePoint, 0.0) * uSizeContrast);
	float pointSize = localSize * uSizeMul * uPixelScale / max(-mv.z, 1.0);
	gl_PointSize = min(max(pointSize, uMinPoint), uMaxPoint);
	gl_Position = projectionMatrix * mv;
}
`;

export const NODE_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vGhost;
varying float vDim;
uniform float uLightMode; // 0 = 深空（白热核心），1 = 晨昼（墨水圆盘 + rim）

void main() {
	vec2 uv = gl_PointCoord - 0.5;
	float d = length(uv);

	float core = smoothstep(0.16, 0.0, d) * 0.18 * (1.0 - vGhost) * (1.0 - uLightMode);
	vec3 col = mix(vColor, vec3(1.0), core);

	float rim = smoothstep(0.36, 0.48, d) * smoothstep(0.51, 0.45, d);
	col = mix(col, col * mix(0.58, 0.68, uLightMode), rim);

	float alpha = smoothstep(0.5, 0.43, d) * mix(1.0, 0.5, vGhost) * vDim;
	if (alpha < 0.01) discard;
	gl_FragColor = vec4(col, alpha);
}
`;
