// The 3D galaxy and 2D radial map intentionally use separate shaders. This
// keeps the galaxy's continuously rendered circle path cheap while allowing
// the radial map to encode semantic shapes without adding draw calls.

export const GALAXY_NODE_VERTEX_SHADER = /* glsl */ `
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

export const GALAXY_NODE_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vGhost;
varying float vDim;

void main() {
	vec2 point = gl_PointCoord - 0.5;
	float distanceFromCenter = length(point);
	float mask = 1.0 - smoothstep(0.43, 0.5, distanceFromCenter);
	float ghostOpacity = mix(1.0, 0.72, step(0.5, vGhost));
	float alpha = mask * ghostOpacity * vDim;
	if (alpha < 0.01) discard;
	gl_FragColor = vec4(vColor, alpha);
}
`;

// aShape: 0 note, 1 folder, 2 folder note, 3 root, 4 outside group,
// 5 outside note, 6 unresolved.
export const RADIAL_NODE_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute float aGhost;
attribute float aShape;
attribute float aDim;
varying vec3 vColor;
varying float vGhost;
varying float vShape;
varying float vDim;
uniform float uPixelScale;
uniform float uSizeMul;
uniform float uSizeContrast;
uniform float uBasePoint;
uniform float uMinPoint;
uniform float uMaxPoint;

void main() {
	vColor = color;
	vGhost = aGhost;
	vShape = aShape;
	vDim = aDim;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	float localSize = max(uBasePoint, uBasePoint + max(aSize - uBasePoint, 0.0) * uSizeContrast);
	float pointSize = localSize * uSizeMul * uPixelScale / max(-mv.z, 1.0);
	gl_PointSize = min(max(pointSize, uMinPoint), uMaxPoint);
	gl_Position = projectionMatrix * mv;
}
`;

export const RADIAL_NODE_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vGhost;
varying float vShape;
varying float vDim;

float roundedBoxSdf(vec2 point, vec2 halfSize, float radius) {
	vec2 q = abs(point) - halfSize + radius;
	return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

void main() {
	vec2 point = gl_PointCoord - 0.5;
	float distanceFromCenter = length(point);
	float circle = 1.0 - smoothstep(0.43, 0.5, distanceFromCenter);
	float circleInner = 1.0 - smoothstep(0.27, 0.34, distanceFromCenter);
	float circleRing = circle * (1.0 - circleInner);
	float squareOuter = 1.0 - smoothstep(-0.025, 0.025, roundedBoxSdf(point, vec2(0.4), 0.085));
	float squareInner = 1.0 - smoothstep(-0.025, 0.025, roundedBoxSdf(point, vec2(0.27), 0.055));
	float squareRing = squareOuter * (1.0 - squareInner);
	float centerCut = 1.0 - smoothstep(0.07, 0.12, distanceFromCenter);
	float rootCenter = 1.0 - smoothstep(0.09, 0.15, distanceFromCenter);
	float diamond = 1.0 - smoothstep(0.43, 0.5, abs(point.x) + abs(point.y));
	float diagonalA = 1.0 - smoothstep(0.035, 0.075, abs(point.x - point.y));
	float diagonalB = 1.0 - smoothstep(0.035, 0.075, abs(point.x + point.y));
	float crossBounds = 1.0 - smoothstep(0.36, 0.44, max(abs(point.x), abs(point.y)));
	float cross = max(diagonalA, diagonalB) * crossBounds;

	float mask = circle;
	if (vShape > 0.5 && vShape < 1.5) mask = squareRing;
	else if (vShape < 2.5 && vShape > 1.5) mask = squareOuter * (1.0 - centerCut);
	else if (vShape < 3.5 && vShape > 2.5) mask = max(circleRing, rootCenter);
	else if (vShape < 4.5 && vShape > 3.5) mask = diamond;
	else if (vShape < 5.5 && vShape > 4.5) mask = circleRing;
	else if (vShape > 5.5) mask = cross;

	float ghostOpacity = mix(1.0, 0.72, step(0.5, vGhost));
	float alpha = mask * ghostOpacity * vDim;
	if (alpha < 0.01) discard;
	gl_FragColor = vec4(vColor, alpha);
}
`;
