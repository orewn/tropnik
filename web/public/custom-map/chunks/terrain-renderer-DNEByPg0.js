//#region web/public/terrain/terrain-renderer.js
var e = Math.PI, t = e * 2, n = 6371008.8, r = Object.freeze({
	yaw: -.48,
	pitch: .72,
	zoom: 1
}), i = [
	223,
	230,
	218
], a = 1050625, o = 5e4, s = 32, c = 48, l = 20, u = (e, t, n) => Math.max(t, Math.min(n, e)), d = (e, t, n) => e + (t - e) * n, f = (e, t, n) => {
	let r = u((n - e) / (t - e), 0, 1);
	return r * r * (3 - 2 * r);
}, p = (e, t) => e[0] * t[0] + e[1] * t[1] + e[2] * t[2], m = (e) => {
	let t = Math.hypot(...e) || 1;
	return e.map((e) => e / t);
}, h = (e, t) => [
	e[1] * t[2] - e[2] * t[1],
	e[2] * t[0] - e[0] * t[2],
	e[0] * t[1] - e[1] * t[0]
];
function g(e, t) {
	let n = e?.source, r = n?.bounds;
	if (!e || !Number.isInteger(e.width) || !Number.isInteger(e.height) || e.width < 2 || e.height < 2 || e.width > 2048 || e.height > 2048 || !(e.pixels instanceof Uint8Array) || e.pixels.length !== e.width * e.height) throw TypeError("Invalid or oversized terrain display mask");
	if (!n || n.scope !== "russia-display-area" || !/^[a-f0-9]{16}$/.test(n.coverageVersion) || ![
		"overview",
		"regional",
		"local",
		"source"
	].includes(n.lod) || !Array.isArray(n.cells) || !n.cells.length || n.cells.length > 1024 || n.cells.some((e) => typeof e != "string" || e.length > 100) || !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || !t?.bounds || !r.every((e, n) => Math.abs(e - t.bounds[n]) < 1e-9) || n.projection !== "regular-longitude-latitude" || n.sampleLayout !== "pixel-cells" || n.rowOrder !== "north-to-south" || n.columnOrder !== "west-to-east" || n.boundaryRule !== "exclude-intersecting-texels" || !Number.isInteger(n.allowedPixels)) throw TypeError("Terrain display mask does not match the source grid");
	let i = 0;
	for (let t of e.pixels) {
		if (t !== 0 && t !== 255) throw TypeError("Invalid terrain display mask coverage");
		t && i++;
	}
	if (i !== n.allowedPixels) throw TypeError("Invalid terrain display mask count");
	return e;
}
function _(e, t, n) {
	return e ? !Number.isFinite(t) || !Number.isFinite(n) || t < 0 || n < 0 || t > 1 || n > 1 ? !1 : e.pixels[Math.min(e.height - 1, Math.floor(n * e.height)) * e.width + Math.min(e.width - 1, Math.floor(t * e.width))] === 255 : !0;
}
function v(e, t) {
	let n = e?.source, r = n?.bounds;
	if (!e || !Number.isInteger(e.width) || !Number.isInteger(e.height) || e.width < 2 || e.height < 2 || e.width > 1024 || e.height > 1024 || !(e.pixels instanceof Uint8ClampedArray) || e.pixels.length !== e.width * e.height * 4) throw TypeError("Invalid or oversized terrain cartography");
	if (!n || typeof n.name != "string" || !n.name || n.name.length > 200 || !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite) || !t?.bounds || !r.every((e, n) => Math.abs(e - t.bounds[n]) < 1e-9) || n.projection !== "regular-longitude-latitude" || n.sampleLayout !== "grid-nodes" || n.rowOrder !== "north-to-south" || n.columnOrder !== "west-to-east" || !Number.isInteger(n.requestedTiles) || n.requestedTiles < 1 || n.requestedTiles > 16 || !Number.isInteger(n.loadedTiles) || n.loadedTiles < 0 || n.loadedTiles > n.requestedTiles) throw TypeError("Terrain cartography does not match the source grid");
	return e;
}
function y(e, t, n, r = [
	0,
	0,
	0,
	0
]) {
	if (!e || !Number.isFinite(t) || !Number.isFinite(n)) return r.fill(0), r;
	let i = e.width, a = e.height, o = e.pixels, s = u(t, 0, 1) * (i - 1), c = u(n, 0, 1) * (a - 1), l = Math.floor(s), d = Math.floor(c), f = Math.min(l + 1, i - 1), p = Math.min(d + 1, a - 1), m = s - l, h = c - d, g = (d * i + l) * 4, _ = (d * i + f) * 4, v = (p * i + l) * 4, y = (p * i + f) * 4, b = (1 - m) * (1 - h) * o[g + 3], x = m * (1 - h) * o[_ + 3], S = (1 - m) * h * o[v + 3], C = m * h * o[y + 3], w = b + x + S + C;
	r[3] = w;
	for (let e = 0; e < 3; e++) r[e] = w ? (o[g + e] * b + o[_ + e] * x + o[v + e] * S + o[y + e] * C) / w : 0;
	return r;
}
function b(e) {
	if (!e || !Number.isInteger(e.width) || !Number.isInteger(e.height) || e.width < 2 || e.height < 2 || e.width * e.height > a || !e.elevations || e.elevations.length !== e.width * e.height) throw TypeError("Invalid or oversized elevation grid");
	let t = e.bounds;
	if (!Array.isArray(t) || t.length !== 4 || !t.every(Number.isFinite) || t[0] >= t[2] || t[1] >= t[3] || t[2] - t[0] > 360 || t[1] < -85 || t[3] > 85) throw TypeError("Invalid terrain bounds");
	if (e.units && e.units !== "meters") throw TypeError("Terrain heights must be in metres");
	if (e.rowOrder && e.rowOrder !== "north-to-south") throw TypeError("Unsupported terrain row order");
	if (e.columnOrder && e.columnOrder !== "west-to-east") throw TypeError("Unsupported terrain column order");
	let n = Infinity, r = -Infinity;
	for (let t = 0; t < e.elevations.length; t++) {
		let i = e.elevations[t];
		if (!Number.isFinite(i) || i < -12e3 || i > 1e4) throw TypeError("Invalid terrain elevation");
		n = Math.min(n, i), r = Math.max(r, i);
	}
	return {
		min: n,
		max: r
	};
}
function x(t) {
	let r = b(t), i = t.bounds, a = t.width, o = t.height, s = n * e / 180, c = (i[2] - i[0]) * s * Math.cos((i[1] + i[3]) * e / 360), l = (i[3] - i[1]) * s, u = Math.max(c, l), d = (r.min + r.max) / 2, f = c / (a - 1), p = l / (o - 1);
	if (![
		c,
		l,
		u,
		f,
		p
	].every((e) => Number.isFinite(e) && e > 0) || !Number.isFinite(Math.fround((r.max - d) / u))) throw TypeError("Invalid terrain scale");
	return {
		grid: t,
		widthM: c,
		heightM: l,
		width: c / u,
		height: l / u,
		scale: u,
		base: d,
		min: r.min,
		max: r.max,
		cellX: f,
		cellY: p
	};
}
function S(e) {
	let t = x(e), n = e.width * e.height;
	return {
		...t,
		heights: new Float32Array(n),
		normals: new Float32Array(n * 3),
		normalTexture: new Uint8Array(n * 4)
	};
}
function C(e, t, n) {
	let { grid: r, scale: i, base: a, cellX: o, cellY: s, heights: c, normals: l, normalTexture: d } = e, f = r.width, p = r.height, m = r.elevations, h = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[-1, 1],
		[1, -1],
		[-1, -1]
	];
	for (let e = t; e < n; e++) {
		let t = e % f, n = Math.floor(e / f), r = m[e];
		c[e] = (r - a) / i;
		let g = Math.max(0, t - 1), _ = Math.min(f - 1, t + 1), v = Math.max(0, n - 1), y = Math.min(p - 1, n + 1), b = (m[n * f + _] - m[n * f + g]) / ((_ - g) * o), x = (m[v * f + t] - m[y * f + t]) / ((y - v) * s), S = Math.hypot(b, x, 1), C = [
			-b / S,
			-x / S,
			1 / S
		], w = 0, T = 0;
		for (let e of [2, 8]) for (let [i, a] of h) {
			let c = u(t + i * e, 0, f - 1), l = u(n + a * e, 0, p - 1), d = Math.hypot((c - t) * o, (l - n) * s);
			d && (w += Math.atan(Math.max(0, m[l * f + c] - r) / d), T++);
		}
		let E = u(1 - .56 * w / Math.max(1, T), .58, 1);
		for (let t = 0; t < 3; t++) l[e * 3 + t] = C[t], d[e * 4 + t] = Math.round((C[t] * .5 + .5) * 255);
		d[e * 4 + 3] = Math.round(E * 255);
	}
}
function w(e) {
	let t = S(e);
	return C(t, 0, e.width * e.height), t;
}
async function T(e, { signal: t } = {}) {
	let n = () => {
		if (t?.aborted) {
			let e = /* @__PURE__ */ Error("Terrain preparation aborted");
			throw e.name = "AbortError", e;
		}
	};
	n(), await new Promise((e) => setTimeout(e, 0)), n();
	let r = S(e), i = e.width * e.height;
	for (let e = 0; e < i; e += 1024) n(), C(r, e, Math.min(i, e + 1024)), e + 1024 < i && await new Promise((e) => setTimeout(e, 0));
	return n(), r;
}
function E(e, t) {
	let n = x(e), r = e.width * e.height, i = t?.grid, a = () => {
		throw TypeError("Prepared terrain model does not match its source grid");
	};
	(!t || !i || i.width !== e.width || i.height !== e.height || !Array.isArray(i.bounds) || i.bounds.length !== 4 || i.bounds.some((t, n) => t !== e.bounds[n]) || i.elevations?.length !== r) && a();
	for (let t of [
		"schemaVersion",
		"units",
		"rowOrder",
		"columnOrder",
		"source",
		"attribution"
	]) JSON.stringify(i[t]) !== JSON.stringify(e[t]) && a();
	for (let e of [
		"widthM",
		"heightM",
		"width",
		"height",
		"scale",
		"base",
		"min",
		"max",
		"cellX",
		"cellY"
	]) (!Number.isFinite(t[e]) || Math.abs(t[e] - n[e]) > Math.max(1, Math.abs(n[e])) * 1e-12) && a();
	(!(t.heights instanceof Float32Array) || t.heights.length !== r || !(t.normals instanceof Float32Array) || t.normals.length !== r * 3 || !(t.normalTexture instanceof Uint8Array) || t.normalTexture.length !== r * 4) && a(), [
		t.heights,
		t.normals,
		t.normalTexture
	].every((e) => e.buffer instanceof ArrayBuffer) || a();
	for (let o = 0; o < r; o++) {
		(i !== e && i.elevations[o] !== e.elevations[o] || !Number.isFinite(t.heights[o]) || t.heights[o] !== Math.fround((e.elevations[o] - n.base) / n.scale)) && a();
		let r = t.normals[o * 3], s = t.normals[o * 3 + 1], c = t.normals[o * 3 + 2], l = r * r + s * s + c * c;
		(!Number.isFinite(l) || l < .999 || l > 1.001 || c <= 0) && a();
	}
	if (t.shadowPyramid !== void 0) {
		let n = 2 ** Math.ceil(Math.log2(e.width - 1)), r = 2 ** Math.ceil(Math.log2(e.height - 1)), i = 0;
		for (Array.isArray(t.shadowPyramid) || a();;) {
			let e = t.shadowPyramid[i++];
			if ((!e || e.width !== n || e.height !== r || !(e.data instanceof Float32Array) || e.data.length !== n * r || !(e.data.buffer instanceof ArrayBuffer) || !e.data.every(Number.isFinite)) && a(), n === 1 && r === 1) break;
			n = Math.max(1, n / 2), r = Math.max(1, r / 2);
		}
		i !== t.shadowPyramid.length && a();
	}
	return t;
}
function D(e) {
	if (e.shadowPyramid) return e.shadowPyramid;
	let t = e.grid.width, n = e.grid.height, r = 2 ** Math.ceil(Math.log2(t - 1)), i = 2 ** Math.ceil(Math.log2(n - 1)), a = new Float32Array(r * i);
	a.fill(-34e37);
	for (let i = 0; i < n - 1; i++) for (let n = 0; n < t - 1; n++) {
		let o = i * t + n;
		a[i * r + n] = Math.max(e.heights[o], e.heights[o + 1], e.heights[o + t], e.heights[o + t + 1]);
	}
	let o = [{
		width: r,
		height: i,
		data: a
	}], s = o[0];
	for (; s.width > 1 || s.height > 1;) {
		let e = {
			width: Math.max(1, s.width / 2),
			height: Math.max(1, s.height / 2)
		};
		e.data = new Float32Array(e.width * e.height);
		for (let t = 0; t < e.height; t++) for (let n = 0; n < e.width; n++) {
			let r = n * 2, i = Math.min(r + 1, s.width - 1), a = t * 2, o = Math.min(a + 1, s.height - 1), c = s.data;
			e.data[t * e.width + n] = Math.max(c[a * s.width + r], c[a * s.width + i], c[o * s.width + r], c[o * s.width + i]);
		}
		o.push(e), s = e;
	}
	return e.shadowPyramid = o, o;
}
function O(e, t, n, r, i, a) {
	let o = e.grid.width, s = e.grid.height, c = u(Math.floor(Math.min(n, i) * (o - 1)), 0, o - 2), l = u(Math.floor(Math.max(n, i) * (o - 1)), 0, o - 2), d = u(Math.floor(Math.min(r, a) * (s - 1)), 0, s - 2), f = u(Math.floor(Math.max(r, a) * (s - 1)), 0, s - 2), p = Math.ceil(Math.log2(Math.max(l - c + 1, f - d + 1))), m = 2 ** p, h = t[p], g = Math.floor(c / m), _ = Math.floor(l / m), v = Math.floor(d / m), y = Math.floor(f / m), b = h.data;
	return Math.max(b[v * h.width + g], b[v * h.width + _], b[y * h.width + g], b[y * h.width + _]);
}
function k(e, t, n, r, i, a = c, o) {
	let s = Number.isFinite(a) ? u(Math.floor(a), 1, c) : c;
	o && (o.queries = 0, o.limitReached = !1);
	let d = Math.hypot(i[0], i[1]);
	if (d < 1e-8 || i[2] <= 0) return 1;
	let p = t / e.widthM + .5, m = .5 - n / e.heightM;
	if (p < 0 || p > 1 || m < 0 || m > 1) return 1;
	let h = i[0] / d / e.width, g = -i[1] / d / e.height, _ = i[2] / d, v = Math.min(e.cellX, e.cellY) / e.scale, y = v * 1.1, b = (r - e.base) / e.scale, x = .8;
	if (h > 1e-12 ? x = Math.min(x, (1 - p) / h) : h < -1e-12 && (x = Math.min(x, -p / h)), g > 1e-12 ? x = Math.min(x, (1 - m) / g) : g < -1e-12 && (x = Math.min(x, -m / g)), x <= y) return 1;
	let S = D(e), C = x - y, w = 0, T = 0, E = 1;
	for (let r = 0; r < s; r++) {
		o && (o.queries = r + 1);
		let a = C * 2 ** -w, s = y + T * a, c = s + a, u = v * .25 + s * .014;
		if (O(e, S, p + h * s, m + g * s, p + h * c, m + g * c) > b + s * _ + v * .18 - u) {
			if (a > v * .65 && w < l) {
				w++, T *= 2;
				continue;
			}
			let r = (s + c) / 2, o = A(e, t + i[0] / d * r * e.scale, n + i[1] / d * r * e.scale);
			if (o !== null) {
				let t = v * .25 + r * .014;
				E = Math.min(E, f(-t, t, b + r * _ + v * .18 - (o - e.base) / e.scale));
			}
			if (E < .005) return E;
		}
		for (let e = 0; e < l; e++) {
			if (w === 0) return E;
			if (!(T & 1)) {
				T++;
				break;
			}
			T = Math.floor(T / 2), w--;
		}
	}
	return o && (o.limitReached = !0), E;
}
function A(e, t, n) {
	if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
	let { grid: r, widthM: i, heightM: a } = e, o = r.width, s = r.height, c = (t / i + .5) * (o - 1), l = (.5 - n / a) * (s - 1);
	if (c < -1e-7 || l < -1e-7 || c > o - 1 + 1e-7 || l > s - 1 + 1e-7) return null;
	c = u(c, 0, o - 1), l = u(l, 0, s - 1);
	let f = Math.min(o - 2, Math.floor(c)), p = Math.min(s - 2, Math.floor(l)), m = c - f, h = l - p, g = r.elevations;
	return d(d(g[p * o + f], g[p * o + f + 1], m), d(g[(p + 1) * o + f], g[(p + 1) * o + f + 1], m), h);
}
function j(e, t, n, r) {
	let i = Math.min(Math.floor(t / r), Math.ceil((e.width - 1) / r) - 1) * r, a = Math.min(Math.floor(n / r), Math.ceil((e.height - 1) / r) - 1) * r;
	return [
		i,
		a,
		Math.min(e.width - 1, i + r),
		Math.min(e.height - 1, a + r)
	];
}
function M(e, t, n, r) {
	let i = e.grid.width, [a, o, s, c] = j(e.grid, t, n, r), l = (t - a) / (s - a), u = (n - o) / (c - o), d = e.heights, f = d[o * i + a], p = d[o * i + s], m = d[c * i + a], h = d[c * i + s];
	return l + u <= 1 ? f + (p - f) * l + (m - f) * u : h + (m - h) * (1 - l) + (p - h) * (1 - u);
}
function N(e, t, n, r) {
	if (!Number.isInteger(r) || r < 1) throw TypeError("Invalid mesh stride");
	if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
	let i = e.grid.width, a = e.grid.height, o = (t / e.widthM + .5) * (i - 1), s = (.5 - n / e.heightM) * (a - 1);
	return o < -1e-7 || s < -1e-7 || o > i - 1 + 1e-7 || s > a - 1 + 1e-7 ? null : M(e, u(o, 0, i - 1), u(s, 0, a - 1), r) * e.scale + e.base;
}
function P(e, t, n) {
	if (!Number.isInteger(n) || n < 1) throw TypeError("Invalid mesh stride");
	if (!Array.isArray(t) || t.length > o) throw RangeError("Route exceeds the terrain preview limit");
	let r = e.grid.width, i = e.grid.height, a = [], s = Math.max(1.5, Math.min(e.cellX, e.cellY) * .08) / e.scale;
	for (let [c, l] of t) {
		let t = (c[0] / e.width + .5) * (r - 1), f = (.5 - c[1] / e.height) * (i - 1), p = (l[0] - c[0]) / e.width * (r - 1), m = -(l[1] - c[1]) / e.height * (i - 1), h = [0, 1];
		if (![
			t,
			f,
			p,
			m
		].every(Number.isFinite)) throw TypeError("Invalid terrain route point");
		if (Math.min(t, t + p) < -1e-7 || Math.max(t, t + p) > r - 1 + 1e-7 || Math.min(f, f + m) < -1e-7 || Math.max(f, f + m) > i - 1 + 1e-7) throw RangeError("Terrain route point is outside the grid");
		let g = (e, t, r) => {
			if (Math.abs(t) < 1e-12) return;
			let i = Math.min(e, e + t), a = Math.max(e, e + t);
			for (let o = Math.max(1, Math.floor(i / n) + 1); o * n < Math.min(a, r); o++) {
				let r = (o * n - e) / t;
				r > 1e-10 && r < .9999999999 && h.push(r);
			}
		};
		g(t, p, r - 1), g(f, m, i - 1), h.sort((e, t) => e - t);
		let _ = h.filter((e, t) => !t || e - h[t - 1] > 1e-10), v = [0];
		for (let a = 1; a < _.length; a++) {
			let o = _[a - 1], s = _[a], c = (o + s) / 2, [l, d, h, g] = j(e.grid, u(t + p * c, 0, r - 1), u(f + m * c, 0, i - 1), n), y = (t + p * o - l) / (h - l) + (f + m * o - d) / (g - d) - 1, b = (t + p * s - l) / (h - l) + (f + m * s - d) / (g - d) - 1;
			if (y * b < 0) {
				let e = o - y * (s - o) / (b - y);
				e - o > 1e-10 && s - e > 1e-10 && v.push(e);
			}
			v.push(s);
		}
		let y;
		for (let h of v) {
			let g = [
				d(c[0], l[0], h),
				d(c[1], l[1], h),
				M(e, u(t + p * h, 0, r - 1), u(f + m * h, 0, i - 1), n) + s
			];
			if (y) {
				if (a.length >= o) throw RangeError("Draped route exceeds the terrain preview limit");
				a.push([y, g]);
			}
			y = g;
		}
	}
	return a;
}
function F(e, t) {
	if (!Number.isInteger(t) || t < 1) throw TypeError("Invalid mesh stride");
	let n = e.grid.width, r = e.grid.height, i = [], a = [];
	for (let e = 0; e < n - 1; e += t) i.push(e);
	i.push(n - 1);
	for (let e = 0; e < r - 1; e += t) a.push(e);
	a.push(r - 1);
	let o = i.length * a.length, s = new Float32Array(o * 2), c = new Uint32Array(o);
	for (let e = 0; e < a.length; e++) for (let t = 0; t < i.length; t++) {
		let o = e * i.length + t;
		s[o * 2] = i[t] / (n - 1), s[o * 2 + 1] = a[e] / (r - 1), c[o] = a[e] * n + i[t];
	}
	let l = new (o > 65535 ? Uint32Array : Uint16Array)((i.length - 1) * (a.length - 1) * 6), u = 0;
	for (let e = 0; e < a.length - 1; e++) for (let t = 0; t < i.length - 1; t++) {
		let n = e * i.length + t, r = n + 1, a = n + i.length, o = a + 1;
		for (let e of [
			n,
			a,
			r,
			r,
			a,
			o
		]) l[u++] = e;
	}
	return {
		uv: s,
		sampleIds: c,
		indices: l,
		count: o,
		step: t,
		triangles: l.length / 3
	};
}
function I(e, t, n = 0, r = a) {
	if (!Number.isFinite(t) || t < 4 || !Number.isFinite(r) || r < 4) throw TypeError("Invalid terrain vertex budget");
	let i = (t) => (Math.ceil((e.width - 1) / t) + 1) * (Math.ceil((e.height - 1) / t) + 1), o = Math.min(a, r), s = Number.isInteger(n) && n >= 1 ? n : 1, c = Math.min(o, t * (n ? 1.25 : 1));
	for (; i(s) > c;) s *= 2;
	let l = t >= o ? o : t * .75;
	for (; s > 1 && i(s / 2) <= l;) s /= 2;
	return s;
}
function L(e, t) {
	let n = .58 + u(t, .28, 1.32) * .12, r = e - 2.246;
	return [
		Math.cos(r) * Math.cos(n),
		Math.sin(r) * Math.cos(n),
		Math.sin(n)
	];
}
function R(e, t) {
	if (!Number.isInteger(t) || t < 1) throw TypeError("Invalid mesh stride");
	let n = e.grid.width, r = e.grid.height, i = [], a = [], o = [], s = (e.min - e.base) / e.scale - .012;
	for (let e = 0; e < n - 1; e += t) i.push(e);
	i.push(n - 1);
	for (let e = 0; e < r - 1; e += t) a.push(e);
	a.push(r - 1);
	let c = (t, i) => [
		(t / (n - 1) - .5) * e.width,
		(.5 - i / (r - 1)) * e.height,
		e.heights[i * n + t]
	], l = (e, t, n) => {
		let r = [
			e[0],
			e[1],
			s
		], i = [
			t[0],
			t[1],
			s
		];
		for (let a of [
			e,
			r,
			t,
			t,
			r,
			i
		]) o.push(...a, ...n);
	};
	for (let e = 1; e < i.length; e++) l(c(i[e - 1], 0), c(i[e], 0), [
		0,
		1,
		0
	]), l(c(i[e], r - 1), c(i[e - 1], r - 1), [
		0,
		-1,
		0
	]);
	for (let e = 1; e < a.length; e++) l(c(0, a[e]), c(0, a[e - 1]), [
		-1,
		0,
		0
	]), l(c(n - 1, a[e - 1]), c(n - 1, a[e]), [
		1,
		0,
		0
	]);
	return {
		vertices: new Float32Array(o),
		floor: s,
		count: o.length / 6,
		triangles: o.length / 18
	};
}
function z(e, t, n) {
	let r = 0, i = 1, a = t[0] - e[0], o = t[1] - e[1], s = [
		-a,
		a,
		-o,
		o
	], c = [
		e[0] - n[0],
		n[2] - e[0],
		e[1] - n[1],
		n[3] - e[1]
	];
	for (let e = 0; e < 4; e++) {
		if (Math.abs(s[e]) < 1e-15) {
			if (c[e] < 0) return null;
			continue;
		}
		let t = c[e] / s[e];
		if (s[e] < 0 ? r = Math.max(r, t) : i = Math.min(i, t), r > i) return null;
	}
	return [[d(e[0], t[0], r), d(e[1], t[1], r)], [d(e[0], t[0], i), d(e[1], t[1], i)]];
}
function B(e, t) {
	let n = [], r = [], i = e.grid.bounds, a = (e, t = 0) => {
		!e || t > 16 || (e.type === "FeatureCollection" && Array.isArray(e.features) ? e.features.forEach((e) => a(e, t + 1)) : e.type === "Feature" ? a(e.geometry, t + 1) : e.type === "GeometryCollection" && Array.isArray(e.geometries) ? e.geometries.forEach((e) => a(e, t + 1)) : e.type === "LineString" && Array.isArray(e.coordinates) ? n.push(e.coordinates) : e.type === "MultiLineString" && Array.isArray(e.coordinates) && n.push(...e.coordinates.filter(Array.isArray)));
	};
	a(t);
	let s = (e) => Array.isArray(e) && e.length >= 2 && Number.isFinite(e[0]) && Number.isFinite(e[1]) && e[1] >= -90 && e[1] <= 90, c = (e, t) => e + 360 * Math.round((t - e) / 360), l = (i[0] + i[2]) / 2, u = (t) => [((t[0] - i[0]) / (i[2] - i[0]) - .5) * e.widthM, ((t[1] - i[1]) / (i[3] - i[1]) - .5) * e.heightM], f = Math.max(1.5, Math.min(e.cellX, e.cellY) * .08), p = Math.max(5, Math.min(e.cellX, e.cellY) * .75), m = !1, h = 0;
	for (let t of n) for (let n = 1; n < t.length; n++) {
		if (++h > 25e4) throw RangeError("Route exceeds the terrain preview limit");
		let a = t[n - 1], g = t[n];
		if (!s(a) || !s(g)) {
			m = !0;
			continue;
		}
		let _ = [c(a[0], l), a[1]], v = [c(g[0], _[0]), g[1]], y = z(_, v, i);
		if (!y) {
			m = !0;
			continue;
		}
		(y[0][0] !== _[0] || y[0][1] !== _[1] || y[1][0] !== v[0] || y[1][1] !== v[1]) && (m = !0);
		let b = u(y[0]), x = u(y[1]), S = Math.hypot(x[0] - b[0], x[1] - b[1]);
		if (S < .01) continue;
		let C = Math.ceil(S / p);
		if (r.length + C > o) throw RangeError("Route exceeds the terrain preview limit");
		let w;
		for (let t = 0; t <= C; t++) {
			let n = d(b[0], x[0], t / C), i = d(b[1], x[1], t / C), a = A(e, n, i);
			if (a === null) {
				w = void 0;
				continue;
			}
			let o = [
				n / e.scale,
				i / e.scale,
				(a - e.base + f) / e.scale
			];
			w && r.push([w, o]), w = o;
		}
	}
	return {
		segments: r,
		clipped: m,
		sourceSegments: h
	};
}
function V(e, t) {
	let n = /* @__PURE__ */ new Float32Array(16);
	for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) for (let a = 0; a < 4; a++) n[r * 4 + i] += e[a * 4 + i] * t[r * 4 + a];
	return n;
}
function H(e) {
	if (e == null) return null;
	let t = {};
	for (let n of [
		"top",
		"right",
		"bottom",
		"left"
	]) t[n] = Number.isFinite(e[n]) ? Math.max(0, e[n]) : 0;
	return t;
}
var U = /* @__PURE__ */ new WeakMap();
function W(t, n) {
	let i = U.get(t);
	if (!i) {
		let e = r.yaw, n = r.pitch, a = [
			Math.sin(e) * Math.cos(n),
			-Math.cos(e) * Math.cos(n),
			Math.sin(n)
		], o = [
			Math.cos(e),
			Math.sin(e),
			0
		], s = h(a, o), c = (t.min - t.base) / t.scale - .012, l = Infinity, d = -Infinity;
		for (let e of [-t.width / 2, t.width / 2]) for (let n of [-t.height / 2, t.height / 2]) for (let r of [c, (t.max - t.base) / t.scale]) {
			let t = e * a[0] + n * a[1] + (r - .005) * a[2];
			l = Math.min(l, t), d = Math.max(d, t);
		}
		let f = Array.from({ length: 64 }, () => [
			Infinity,
			-Infinity,
			Infinity,
			-Infinity,
			Infinity,
			-Infinity
		]), p = (e, t, n) => {
			let r = n - .005, i = e * o[0] + t * o[1], c = e * s[0] + t * s[1] + r * s[2], p = e * a[0] + t * a[1] + r * a[2], m = f[u(Math.floor((p - l) / Math.max(1e-9, d - l) * 64), 0, 63)];
			m[0] = Math.min(m[0], i), m[1] = Math.max(m[1], i), m[2] = Math.min(m[2], c), m[3] = Math.max(m[3], c), m[4] = Math.min(m[4], p), m[5] = Math.max(m[5], p);
		}, m = t.grid.width, g = t.grid.height;
		for (let e = 0; e < g; e++) for (let n = 0; n < m; n++) p((n / (m - 1) - .5) * t.width, (.5 - e / (g - 1)) * t.height, t.heights[e * m + n]);
		for (let e of [-t.width / 2, t.width / 2]) for (let n of [-t.height / 2, t.height / 2]) p(e, n, c);
		i = {
			bins: f.filter((e) => Number.isFinite(e[0])),
			fits: /* @__PURE__ */ new Map()
		}, U.set(t, i);
	}
	let a = String(n);
	if (i.fits.has(a)) return i.fits.get(a);
	let o = (e) => {
		let t = Infinity, n = -Infinity, r = Infinity, a = -Infinity;
		for (let o of i.bins) {
			let i = e - o[5], s = e - o[4];
			t = Math.min(t, o[0] / (o[0] <= 0 ? i : s)), n = Math.max(n, o[1] / (o[1] >= 0 ? i : s)), r = Math.min(r, o[2] / (o[2] <= 0 ? i : s)), a = Math.max(a, o[3] / (o[3] >= 0 ? i : s));
		}
		return {
			left: t,
			right: n,
			bottom: r,
			top: a
		};
	}, s = Math.tan(42 * e / 360), c = .78, l = 2 * s * n * c, d = 2 * s * c, f = (e) => e.right - e.left <= l && e.top - e.bottom <= d, p = Math.max(...i.bins.map((e) => e[5])) + .02, m = Math.max(2, p * 2);
	for (let e = 0; e < 24 && !f(o(m)); e++) m *= 2;
	for (let e = 0; e < 20; e++) {
		let e = (p + m) / 2;
		f(o(e)) ? m = e : p = e;
	}
	let g = o(m), _ = {
		distance: m,
		centerX: (g.left + g.right) / 2,
		centerY: (g.bottom + g.top) / 2
	};
	return i.fits.size >= 8 && i.fits.delete(i.fits.keys().next().value), i.fits.set(a, _), _;
}
function G(t, n, r, i, a) {
	let o = n.viewportInsets || {
		top: 0,
		right: 0,
		bottom: a && r < 700 ? i * .47 : 0,
		left: 0
	}, s = o.left + o.right, c = o.top + o.bottom, l = s ? Math.min(1, r * .88 / s) : 1, u = c ? Math.min(1, i * .88 / c) : 1, d = o.left * l, f = o.right * l, g = o.top * u, _ = o.bottom * u, v = Math.max(1, r - d - f), y = Math.max(1, i - g - _), b = v / y, x = 42 * e / 180, S = [
		Math.sin(n.yaw) * Math.cos(n.pitch),
		-Math.cos(n.yaw) * Math.cos(n.pitch),
		Math.sin(n.pitch)
	], C = m(h([
		0,
		0,
		1
	], S)), w = h(S, C), T = Math.tan(x / 2), E = W(t, b), D = E.distance / n.zoom, O = [
		n.offset[0],
		n.offset[1],
		.005
	].map((e, t) => e + S[t] * D), k = new Float32Array([
		C[0],
		w[0],
		S[0],
		0,
		C[1],
		w[1],
		S[1],
		0,
		C[2],
		w[2],
		S[2],
		0,
		-p(C, O),
		-p(w, O),
		-p(S, O),
		1
	]), A = 1 / T * y / i, j = .012, M = Math.max(12, D + 2 * Math.hypot(t.width, t.height, (t.max - t.min) / t.scale));
	return {
		matrix: V(new Float32Array([
			A / (r / i),
			0,
			0,
			0,
			0,
			A,
			0,
			0,
			0,
			0,
			(M + j) / (j - M),
			-1,
			0,
			0,
			2 * M * j / (j - M),
			0
		]), k),
		offset: [(d - f) / r - E.centerX / T * y / r, (_ - g) / i - E.centerY / T * y / i],
		eye: O,
		distance: D,
		usableW: v,
		usableH: y,
		right: C,
		forward: S
	};
}
function K(e, t, n, r) {
	let i = t.matrix, [a, o, s] = e, c = i[3] * a + i[7] * o + i[11] * s + i[15];
	return c <= .012 ? null : [
		((i[0] * a + i[4] * o + i[8] * s + i[12]) / c + t.offset[0]) * n * .5 + n * .5,
		(1 - (i[1] * a + i[5] * o + i[9] * s + i[13]) / c - t.offset[1]) * r * .5,
		(i[2] * a + i[6] * o + i[10] * s + i[14]) / c,
		1 / c
	];
}
var q = "\nuniform highp sampler2D uHeight;\nuniform vec2 uGrid;\nuniform vec2 uExtent;\nfloat heightAt(vec2 uv) {\n vec2 p=clamp(uv,0.0,1.0)*(uGrid-1.0);\n ivec2 a=ivec2(floor(p)),b=min(a+ivec2(1),ivec2(uGrid)-1);\n vec2 f=fract(p);\n return mix(mix(texelFetch(uHeight,a,0).r,texelFetch(uHeight,ivec2(b.x,a.y),0).r,f.x),\n  mix(texelFetch(uHeight,ivec2(a.x,b.y),0).r,texelFetch(uHeight,b,0).r,f.x),f.y);\n}\n", J = "#version 300 es\nprecision highp float;\nlayout(location=0) in vec2 aUV;\nuniform mat4 uMatrix;\nuniform vec2 uOffset;\nout vec2 vUV;\nout vec3 vPosition;\n" + q + "\nvoid main(){\n vUV=aUV;vPosition=vec3((aUV.x-.5)*uExtent.x,(.5-aUV.y)*uExtent.y,heightAt(aUV));\n gl_Position=uMatrix*vec4(vPosition,1.0);gl_Position.xy+=uOffset*gl_Position.w;\n}\n";
function Y(e, t, n, r = 0) {
	let i = (e, t) => {
		e = (e % n + n) % n, t = (t % n + n) % n;
		let i = Math.imul(e + 1, 374761393) ^ Math.imul(t + 1, 668265263) ^ Math.imul(r + 1, 1274126177);
		return i = Math.imul(i ^ i >>> 13, 1274126177), ((i ^ i >>> 16) >>> 0) / 4294967295;
	}, a = Math.floor(e), o = Math.floor(t), s = e - a, c = t - o, l = s * s * s * (s * (s * 6 - 15) + 10), u = c * c * c * (c * (c * 6 - 15) + 10);
	return d(d(i(a, o), i(a + 1, o), l), d(i(a, o + 1), i(a + 1, o + 1), l), u);
}
function X(e = 128) {
	if (!Number.isInteger(e) || e < 32 || e > 256 || e & e - 1) throw TypeError("Surface texture must be a bounded power of two");
	let t = new Uint8Array(e * e * 4);
	for (let n = 0; n < e; n++) for (let r = 0; r < e; r++) {
		let i = r / e, a = n / e, o = Y(i * 4, a * 4, 4, 3), s = Y(i * 16, a * 16, 16, 7), c = Y(i * 32, a * 32, 32, 19), l = Y(i * 64, a * 64, 64, 41), d = 1 - Math.abs(2 * s - 1), f = .5 + .5 * Math.sin((a + o * .12) * Math.PI * 16), p = [
			.32 * s + .42 * c + .26 * l,
			.54 * d + .46 * f,
			o,
			.56 * c + .44 * l
		];
		for (let i = 0; i < 4; i++) t[(n * e + r) * 4 + i] = Math.round(u(p[i], 0, 1) * 255);
	}
	return {
		size: e,
		pixels: t
	};
}
function Z(e) {
	let t = [
		[500, [
			.16,
			.29,
			.24
		]],
		[1400, [
			.3,
			.43,
			.31
		]],
		[2100, [
			.51,
			.55,
			.36
		]],
		[2700, [
			.64,
			.62,
			.52
		]],
		[3400, [
			.76,
			.75,
			.68
		]]
	], n = t[0], r = t[1];
	for (let i = 1; i < t.length - 1 && e >= t[i][0]; i++) n = t[i], r = t[i + 1];
	let i = f(n[0], r[0], e);
	return n[1].map((e, t) => d(e, r[1][t], i));
}
var Q = "#version 300 es\nprecision highp float;\nin vec2 vUV;\nin vec3 vPosition;\nuniform sampler2D uNormal;\nuniform sampler2D uShadow;\nuniform sampler2D uSurface;\nuniform sampler2D uCartography;\nuniform sampler2D uDisplayMask;\nuniform vec2 uCartographySize;\nuniform vec2 uGrid;\nuniform vec3 uLight;\nuniform vec3 uEye;\nuniform float uBase;\nuniform float uScale;\nuniform float uShadowTexel;\nout vec4 outColor;\nvec3 palette(float h){\n vec3 a=vec3(.16,.29,.24),b=vec3(.30,.43,.31),c=vec3(.51,.55,.36),d=vec3(.64,.62,.52),e=vec3(.76,.75,.68);\n if(h<1400.0)return mix(a,b,smoothstep(500.0,1400.0,h));\n if(h<2100.0)return mix(b,c,smoothstep(1400.0,2100.0,h));\n if(h<2700.0)return mix(c,d,smoothstep(2100.0,2700.0,h));\n return mix(d,e,smoothstep(2700.0,3400.0,h));\n}\nvec4 surfaceAt(vec3 p,vec3 n){\n vec3 w=pow(abs(n),vec3(4.0));w/=max(dot(w,vec3(1)),.001);\n return texture(uSurface,p.yz)*w.x+texture(uSurface,p.xz)*w.y+texture(uSurface,p.xy)*w.z;\n}\nvec3 perturbNormal(vec3 p,vec3 n,float height){\n vec3 dp1=dFdx(p),dp2=dFdy(p),r1=cross(dp2,n),r2=cross(n,dp1);\n float determinant=dot(dp1,r1);\n if(abs(determinant)<1e-14)return n;\n vec3 gradient=dFdx(height)*r1+dFdy(height)*r2;\n return normalize(abs(determinant)*n-sign(determinant)*gradient);\n}\nvoid main(){\n if(texture(uDisplayMask,vUV).r<.5)discard;\n vec2 nUV=(vUV*(uGrid-1.0)+.5)/uGrid;\n vec4 tex=texture(uNormal,nUV);vec3 baseNormal=normalize(tex.rgb*2.0-1.0);\n float elevation=vPosition.z*uScale+uBase;\n vec3 metres=vPosition*uScale;\n vec4 macro=surfaceAt(metres/820.0,baseNormal),detail=surfaceAt(metres/96.0,baseNormal);\n float rock=smoothstep(.17,.52,1.0-baseNormal.z);\n rock=max(rock,smoothstep(2300.0,3050.0,elevation)*(.26+macro.b*.35));\n vec3 limestone=mix(vec3(.49,.51,.47),vec3(.72,.69,.61),macro.b*.64+detail.g*.36);\n vec3 albedo=mix(palette(elevation)*(.91+macro.b*.18),limestone,rock*.83);\n albedo*=.94+detail.r*.12;\n vec2 coverUV=(vUV*(uCartographySize-1.0)+.5)/uCartographySize;\n vec4 cover=texture(uCartography,coverUV);\n albedo=mix(albedo,cover.rgb/max(cover.a,.00001),cover.a);\n // Triplanar detail is filtered with mipmaps and never changes terrain positions.\n float bump=(detail.g*.7+detail.r*.3-.5)*mix(.12,.55,rock)*(1.0-cover.a*.85)/uScale;\n vec3 n=perturbNormal(vPosition,baseNormal,bump);\n float contourDistance=abs(fract(elevation/100.0+.5)-.5)*100.0;\n float contour=1.0-smoothstep(0.0,max(.7,fwidth(elevation)*.85),contourDistance);\n albedo*=1.0-contour*.035;\n float shadow=texture(uShadow,vUV).r*.5;\n shadow+=(texture(uShadow,vUV+vec2(uShadowTexel,0)).r+texture(uShadow,vUV-vec2(uShadowTexel,0)).r+\n  texture(uShadow,vUV+vec2(0,uShadowTexel)).r+texture(uShadow,vUV-vec2(0,uShadowTexel)).r)*.125;\n vec3 view=normalize(uEye-vPosition),halfVector=normalize(view+uLight);\n float NoL=max(dot(n,uLight),0.0),NoV=max(dot(n,view),.001),NoH=max(dot(n,halfVector),0.0),VoH=max(dot(view,halfVector),0.0);\n float roughness=mix(.94,.76,rock),alpha=roughness*roughness,a2=alpha*alpha;\n float denominator=NoH*NoH*(a2-1.0)+1.0;\n float distribution=a2/(3.14159265*denominator*denominator);\n float k=(roughness+1.0)*(roughness+1.0)/8.0;\n float visibility=NoV/(NoV*(1.0-k)+k)*NoL/(NoL*(1.0-k)+k);\n float fresnel=.035+.965*pow(1.0-VoH,5.0);\n float specular=distribution*visibility*fresnel/max(4.0*NoL*NoV,.001);\n vec3 linearAlbedo=pow(albedo,vec3(2.2));\n vec3 ambient=mix(vec3(.25,.29,.24),vec3(.35,.43,.46),clamp(n.z*.5+.5,0.0,1.0))*tex.a;\n vec3 lit=linearAlbedo*ambient+(linearAlbedo*.965+vec3(specular)) *vec3(1.15,1.06,.91)*NoL*shadow;\n vec3 color=pow(max(lit,vec3(0)),vec3(1.0/2.2));\n float haze=clamp((distance(uEye,vPosition)-.9)*.10,0.0,.22);\n float edge=min(min(vUV.x,1.0-vUV.x),min(vUV.y,1.0-vUV.y));\n haze=max(haze,(1.0-smoothstep(0.0,.003,edge))*.15);\n outColor=vec4(mix(color,vec3(.875,.902,.855),haze),1.0);\n}\n", ee = "#version 300 es\nprecision highp float;\nout vec2 vUV;\nvoid main(){\n vec2 p=vec2(gl_VertexID==1?3.0:-1.0,gl_VertexID==2?3.0:-1.0);\n vUV=p*.5+.5;gl_Position=vec4(p,0,1);\n}\n", te = "#version 300 es\nprecision highp float;\nprecision highp int;\nin vec2 vUV;\nuniform vec3 uLight;\nuniform int uSteps;\nuniform highp sampler2D uHeightMax;\nout vec4 outColor;\n" + q + `
float maximumHeight(vec2 a,vec2 b){
 ivec2 lo=clamp(ivec2(floor(min(a,b)*(uGrid-1.0))),ivec2(0),ivec2(uGrid)-2);
 ivec2 hi=clamp(ivec2(floor(max(a,b)*(uGrid-1.0))),ivec2(0),ivec2(uGrid)-2);
 int level=int(ceil(log2(float(max(hi.x-lo.x+1,hi.y-lo.y+1))))),block=1<<level;lo/=block;hi/=block;
 return max(max(texelFetch(uHeightMax,lo,level).r,texelFetch(uHeightMax,ivec2(hi.x,lo.y),level).r),
  max(texelFetch(uHeightMax,ivec2(lo.x,hi.y),level).r,texelFetch(uHeightMax,hi,level).r));
}
float visibilityAt(){
 float h=heightAt(vUV),cell=min(uExtent.x/(uGrid.x-1.0),uExtent.y/(uGrid.y-1.0));
 float horizontal=length(uLight.xy),slope=uLight.z/max(horizontal,.01);
 vec2 dir=vec2(uLight.x/uExtent.x,-uLight.y/uExtent.y)/max(horizontal,.01);
 float start=cell*1.1,end=.8;
 if(dir.x>1e-12)end=min(end,(1.0-vUV.x)/dir.x);else if(dir.x< -1e-12)end=min(end,-vUV.x/dir.x);
 if(dir.y>1e-12)end=min(end,(1.0-vUV.y)/dir.y);else if(dir.y< -1e-12)end=min(end,-vUV.y/dir.y);
 if(end<=start)return 1.0;
 float span=end-start,visibility=1.0;int level=0,index=0;
 for(int work=0;work<${c};work++){
  if(work>=uSteps)break;
  float segment=span*exp2(-float(level)),lo=start+float(index)*segment,hi=lo+segment;
  float maximum=maximumHeight(vUV+dir*lo,vUV+dir*hi),softness=cell*.25+lo*.014;
  if(maximum>h+lo*slope+cell*.18-softness){
   if(segment>cell*.65&&level<${l}){level++;index*=2;continue;}
   float d=(lo+hi)*.5,s=cell*.25+d*.014,clearance=h+d*slope+cell*.18-heightAt(vUV+dir*d);
   visibility=min(visibility,smoothstep(-s,s,clearance));if(visibility<.005)return visibility;
  }
  for(int up=0;up<${l};up++){
   if(level==0)return visibility;
   if((index&1)==0){index++;break;}index/=2;level--;
  }
 }
 return visibility;
}
void main(){
 float visibility=visibilityAt();
 outColor=vec4(visibility,visibility,visibility,1);
}
`, ne = "#version 300 es\nprecision highp float;\nlayout(location=0) in vec3 aStart;\nlayout(location=1) in vec3 aEnd;\nlayout(location=2) in vec2 aCorner;\nuniform mat4 uMatrix;\nuniform vec2 uOffset;\nuniform vec2 uViewport;\nuniform float uHalfWidth;\nout vec2 vDistance;\nout vec2 vWorld;\nflat out float vLength;\nvoid main(){\n vec4 a=uMatrix*vec4(aStart,1),b=uMatrix*vec4(aEnd,1);\n if(a.w<=.012||b.w<=.012){gl_Position=vec4(2,2,2,1);vDistance=vec2(0);vLength=0.0;return;}\n vec2 delta=(b.xy/b.w-a.xy/a.w)*uViewport*.5;\n float len=max(length(delta),.001);vec2 direction=delta/len,normal=vec2(-direction.y,direction.x);\n vec4 point=mix(a,b,aCorner.x);\n point.xy+=(normal*aCorner.y*uHalfWidth+direction*(aCorner.x*2.0-1.0)*uHalfWidth)*2.0/uViewport*point.w;\n point.xy+=uOffset*point.w;gl_Position=point;\n vWorld=mix(aStart.xy,aEnd.xy,aCorner.x);\n vDistance=vec2(aCorner.x*len+(aCorner.x*2.0-1.0)*uHalfWidth,aCorner.y*uHalfWidth);vLength=len;\n}\n", re = "#version 300 es\nprecision highp float;\nin vec2 vDistance;\nin vec2 vWorld;\nflat in float vLength;\nuniform vec4 uColor;\nuniform float uHalfWidth;\nuniform sampler2D uDisplayMask;\nuniform vec2 uExtent;\nout vec4 outColor;\nvoid main(){\n vec2 uv=vec2(vWorld.x/uExtent.x+.5,.5-vWorld.y/uExtent.y);\n if(any(lessThan(uv,vec2(0)))||any(greaterThan(uv,vec2(1)))||texture(uDisplayMask,uv).r<.5)discard;\n float cap=max(max(-vDistance.x,vDistance.x-vLength),0.0),dist=length(vec2(cap,vDistance.y));\n float alpha=1.0-smoothstep(uHalfWidth-.8,uHalfWidth,dist);if(alpha<=0.0)discard;\n outColor=vec4(uColor.rgb,uColor.a*alpha);\n}\n", ie = "#version 300 es\nprecision highp float;\nlayout(location=0) in vec3 aPosition;\nlayout(location=1) in vec3 aNormal;\nuniform mat4 uMatrix;\nuniform vec2 uOffset;\nout vec3 vPosition;\nout vec3 vNormal;\nvoid main(){vPosition=aPosition;vNormal=aNormal;gl_Position=uMatrix*vec4(aPosition,1);gl_Position.xy+=uOffset*gl_Position.w;}\n", ae = "#version 300 es\nprecision highp float;\nin vec3 vPosition;\nin vec3 vNormal;\nuniform vec3 uLight;\nuniform float uFloor;\nout vec4 outColor;\nvoid main(){\n float elevation=clamp((vPosition.z-uFloor)/.17,0.0,1.0);\n vec3 color=mix(vec3(.34,.38,.33),vec3(.49,.53,.46),elevation);\n float light=.40+.60*max(dot(normalize(vNormal),uLight),0.0);\n outColor=vec4(color*light,1);\n}\n", oe = "#version 300 es\nprecision highp float;\nuniform mat4 uMatrix;\nuniform vec2 uOffset;\nuniform vec2 uExtent;\nuniform float uFloor;\nout vec2 vPoint;\nvoid main(){\n int id=gl_VertexID;\n vec2 uv=vec2(id==1||id==4||id==5?1.0:0.0,id==2||id==3||id==5?1.0:0.0);\n vPoint=(uv-.5)*(uExtent+vec2(.08));\n gl_Position=uMatrix*vec4(vPoint,uFloor-.001,1);gl_Position.xy+=uOffset*gl_Position.w;\n}\n", se = "#version 300 es\nprecision highp float;\nuniform vec2 uExtent;\nin vec2 vPoint;\nout vec4 outColor;\nvoid main(){\n float distanceToBase=length(max(abs(vPoint)-uExtent*.5,vec2(0)));\n float contact=1.0-smoothstep(0.0,.04,distanceToBase);\n outColor=vec4(.20,.27,.21,contact*contact*.18);\n}\n", $ = class {
	constructor(e, t, n = null) {
		this.gl = e, this.model = t, this.displayMask = n, this.resources = [], this.meshes = /* @__PURE__ */ new Map(), this.shadows = /* @__PURE__ */ new Map(), this.routeCount = 0;
		try {
			if (e.getParameter(e.MAX_TEXTURE_SIZE) < Math.max(t.grid.width, t.grid.height) || e.getParameter(e.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 1) throw Error("Terrain GPU limits");
			if (n && (e.getParameter(e.MAX_TEXTURE_SIZE) < Math.max(n.width, n.height) || e.getParameter(e.STENCIL_BITS) < 1)) throw Error("Terrain display mask GPU limits");
			this.anisotropy = e.getExtension("EXT_texture_filter_anisotropic"), this.maxAnisotropy = this.anisotropy ? Math.min(4, e.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1, this.terrain = this.program(J, Q), this.shadow = this.program(ee, te), this.line = this.program(ne, re), this.boundary = this.program(ie, ae), this.ground = this.program(oe, se), this.heightTexture = this.texture(e.R32F, t.grid.width, t.grid.height, e.RED, e.FLOAT, t.heights, e.NEAREST), this.maskTexture = this.texture(e.R8, n?.width || 1, n?.height || 1, e.RED, e.UNSIGNED_BYTE, n?.pixels || new Uint8Array([255]), e.NEAREST), this.normalTexture = this.texture(e.RGBA8, t.grid.width, t.grid.height, e.RGBA, e.UNSIGNED_BYTE, t.normalTexture, e.LINEAR), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.LINEAR_MIPMAP_LINEAR), e.generateMipmap(e.TEXTURE_2D);
			let r = D(t), i = r[0];
			this.maxHeightTexture = this.texture(e.R32F, i.width, i.height, e.RED, e.FLOAT, i.data, e.NEAREST);
			for (let t = 1; t < r.length; t++) {
				let n = r[t];
				e.texImage2D(e.TEXTURE_2D, t, e.R32F, n.width, n.height, 0, e.RED, e.FLOAT, n.data);
			}
			if (e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAX_LEVEL, r.length - 1), e.getError() !== e.NO_ERROR) throw Error("Terrain texture allocation failed");
			let a = X(128);
			this.surfaceTexture = this.texture(e.RGBA8, a.size, a.size, e.RGBA, e.UNSIGNED_BYTE, a.pixels, e.LINEAR), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.REPEAT), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.REPEAT), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, e.LINEAR_MIPMAP_LINEAR), e.generateMipmap(e.TEXTURE_2D), this.setCartography(null), this.emptyVAO = this.track(e.createVertexArray(), "VertexArray"), this.routeVAO = this.track(e.createVertexArray(), "VertexArray"), this.routeBuffer = this.track(e.createBuffer(), "Buffer"), e.bindVertexArray(this.routeVAO), e.bindBuffer(e.ARRAY_BUFFER, this.routeBuffer);
			for (let [t, n, r] of [
				[
					0,
					3,
					0
				],
				[
					1,
					3,
					12
				],
				[
					2,
					2,
					24
				]
			]) e.enableVertexAttribArray(t), e.vertexAttribPointer(t, n, e.FLOAT, !1, 32, r);
			e.bindVertexArray(null);
		} catch (e) {
			throw this.destroy(), e;
		}
	}
	track(e, t) {
		if (!e) throw Error("Terrain GPU allocation failed");
		return this.resources.push([e, t]), e;
	}
	setCartography(e) {
		let t = this.gl, n = e?.width || 1, r = e?.height || 1, i = e ? new Uint8Array(e.pixels) : /* @__PURE__ */ new Uint8Array(4);
		if (e) for (let e = 0; e < i.length; e += 4) {
			let t = i[e + 3] / 255;
			for (let n = 0; n < 3; n++) i[e + n] = Math.round(i[e + n] * t);
		}
		let a = this.texture(t.RGBA8, n, r, t.RGBA, t.UNSIGNED_BYTE, i, t.LINEAR);
		if (t.texParameteri(t.TEXTURE_2D, t.TEXTURE_MIN_FILTER, t.LINEAR_MIPMAP_LINEAR), t.generateMipmap(t.TEXTURE_2D), t.getError() !== t.NO_ERROR) throw t.deleteTexture(a), this.resources = this.resources.filter(([e]) => e !== a), Error("Terrain cartography texture allocation failed");
		this.cartographyTexture && (t.deleteTexture(this.cartographyTexture), this.resources = this.resources.filter(([e]) => e !== this.cartographyTexture)), this.cartographyTexture = a, this.cartographySize = [n, r];
	}
	program(e, t) {
		let n = this.gl, r = [];
		try {
			for (let [i, a] of [[n.VERTEX_SHADER, e], [n.FRAGMENT_SHADER, t]]) {
				let e = n.createShader(i);
				if (!e) throw Error("Terrain shader unavailable");
				if (r.push(e), n.shaderSource(e, a), n.compileShader(e), !n.getShaderParameter(e, n.COMPILE_STATUS)) throw Error("Terrain shader: " + n.getShaderInfoLog(e));
			}
			let i = this.track(n.createProgram(), "Program");
			if (r.forEach((e) => n.attachShader(i, e)), n.linkProgram(i), !n.getProgramParameter(i, n.LINK_STATUS)) throw Error("Terrain shader link: " + n.getProgramInfoLog(i));
			return {
				program: i,
				uniforms: /* @__PURE__ */ new Map()
			};
		} finally {
			r.forEach((e) => n.deleteShader(e));
		}
	}
	uniform(e, t) {
		return e.uniforms.has(t) || e.uniforms.set(t, this.gl.getUniformLocation(e.program, t)), e.uniforms.get(t);
	}
	texture(e, t, n, r, i, a, o) {
		let s = this.gl, c = this.track(s.createTexture(), "Texture");
		return s.bindTexture(s.TEXTURE_2D, c), s.texParameteri(s.TEXTURE_2D, s.TEXTURE_MIN_FILTER, o), s.texParameteri(s.TEXTURE_2D, s.TEXTURE_MAG_FILTER, o), s.texParameteri(s.TEXTURE_2D, s.TEXTURE_WRAP_S, s.CLAMP_TO_EDGE), s.texParameteri(s.TEXTURE_2D, s.TEXTURE_WRAP_T, s.CLAMP_TO_EDGE), o === s.LINEAR && this.anisotropy && s.texParameterf(s.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy), s.pixelStorei(s.UNPACK_ALIGNMENT, 1), s.texImage2D(s.TEXTURE_2D, 0, e, t, n, 0, r, i, a), c;
	}
	heightUniforms(e) {
		let t = this.gl, n = this.model;
		t.activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, this.heightTexture), t.uniform1i(this.uniform(e, "uHeight"), 0), t.uniform2f(this.uniform(e, "uGrid"), n.grid.width, n.grid.height), t.uniform2f(this.uniform(e, "uExtent"), n.width, n.height);
	}
	maskUniforms(e) {
		let t = this.gl;
		t.activeTexture(t.TEXTURE6), t.bindTexture(t.TEXTURE_2D, this.maskTexture), t.uniform1i(this.uniform(e, "uDisplayMask"), 6);
	}
	ensureMesh(e) {
		if (this.meshes.has(e.step)) return this.meshes.get(e.step);
		let t = this.gl, n = this.track(t.createVertexArray(), "VertexArray"), r = this.track(t.createBuffer(), "Buffer"), i = this.track(t.createBuffer(), "Buffer");
		t.bindVertexArray(n), t.bindBuffer(t.ARRAY_BUFFER, r), t.bufferData(t.ARRAY_BUFFER, e.uv, t.STATIC_DRAW), t.enableVertexAttribArray(0), t.vertexAttribPointer(0, 2, t.FLOAT, !1, 8, 0), t.bindBuffer(t.ELEMENT_ARRAY_BUFFER, i), t.bufferData(t.ELEMENT_ARRAY_BUFFER, e.indices, t.STATIC_DRAW), t.bindVertexArray(null);
		let a = this.displayMask ? {
			vertices: /* @__PURE__ */ new Float32Array(),
			count: 0,
			floor: 0
		} : R(this.model, e.step), o = this.track(t.createVertexArray(), "VertexArray"), s = this.track(t.createBuffer(), "Buffer");
		t.bindVertexArray(o), t.bindBuffer(t.ARRAY_BUFFER, s), t.bufferData(t.ARRAY_BUFFER, a.vertices, t.STATIC_DRAW);
		for (let [e, n] of [[0, 0], [1, 12]]) t.enableVertexAttribArray(e), t.vertexAttribPointer(e, 3, t.FLOAT, !1, 24, n);
		t.bindVertexArray(null);
		let c = {
			vao: n,
			count: e.indices.length,
			type: e.indices instanceof Uint32Array ? t.UNSIGNED_INT : t.UNSIGNED_SHORT,
			boundaryVAO: o,
			boundaryCount: a.count,
			floor: a.floor
		};
		return this.meshes.set(e.step, c), c;
	}
	setRoute(e) {
		let t = this.gl, n = new Float32Array(e.length * 6 * 8), r = [
			[0, -1],
			[1, -1],
			[0, 1],
			[0, 1],
			[1, -1],
			[1, 1]
		], i = 0;
		for (let [t, a] of e) for (let e of r) n.set(t, i), n.set(a, i + 3), n.set(e, i + 6), i += 8;
		t.bindBuffer(t.ARRAY_BUFFER, this.routeBuffer), t.bufferData(t.ARRAY_BUFFER, n, t.STATIC_DRAW), this.routeCount = e.length * 6;
	}
	shadowMap(e, t) {
		let n = this.gl, r = t.shadowSize, i = t.shadowQueries, a = this.shadows.get(r);
		if (!a) {
			let e = this.texture(n.RGBA8, r, r, n.RGBA, n.UNSIGNED_BYTE, null, n.LINEAR), t = this.track(n.createFramebuffer(), "Framebuffer");
			if (n.bindFramebuffer(n.FRAMEBUFFER, t), n.framebufferTexture2D(n.FRAMEBUFFER, n.COLOR_ATTACHMENT0, n.TEXTURE_2D, e, 0), n.checkFramebufferStatus(n.FRAMEBUFFER) !== n.FRAMEBUFFER_COMPLETE) throw Error("Terrain shadow target unavailable");
			a = {
				texture: e,
				framebuffer: t,
				key: ""
			}, this.shadows.set(r, a);
		}
		let o = i + ":" + e.join(":");
		return a.key !== o && (n.bindFramebuffer(n.FRAMEBUFFER, a.framebuffer), n.viewport(0, 0, r, r), n.disable(n.DEPTH_TEST), n.disable(n.BLEND), n.disable(n.CULL_FACE), n.useProgram(this.shadow.program), this.heightUniforms(this.shadow), n.activeTexture(n.TEXTURE3), n.bindTexture(n.TEXTURE_2D, this.maxHeightTexture), n.uniform1i(this.uniform(this.shadow, "uHeightMax"), 3), n.uniform3fv(this.uniform(this.shadow, "uLight"), e), n.uniform1i(this.uniform(this.shadow, "uSteps"), i), n.bindVertexArray(this.emptyVAO), n.drawArrays(n.TRIANGLES, 0, 3), a.key = o), {
			texture: a.texture,
			size: r
		};
	}
	render(e, t, n, r, a, o, s) {
		let c = this.gl, l = this.model, u = this.shadowMap(n, s), d = this.ensureMesh(e);
		if (c.bindFramebuffer(c.FRAMEBUFFER, null), c.viewport(0, 0, r, a), c.clearColor(i[0] / 255, i[1] / 255, i[2] / 255, 1), c.disable(c.STENCIL_TEST), c.clearDepth(1), c.depthMask(!0), this.displayMask && (c.stencilMask(255), c.clearStencil(0)), c.clear(c.COLOR_BUFFER_BIT | c.DEPTH_BUFFER_BIT | (this.displayMask ? c.STENCIL_BUFFER_BIT : 0)), this.displayMask || (c.disable(c.DEPTH_TEST), c.disable(c.CULL_FACE), c.depthMask(!1), c.enable(c.BLEND), c.blendFunc(c.SRC_ALPHA, c.ONE_MINUS_SRC_ALPHA), c.useProgram(this.ground.program), c.uniformMatrix4fv(this.uniform(this.ground, "uMatrix"), !1, t.matrix), c.uniform2fv(this.uniform(this.ground, "uOffset"), t.offset), c.uniform2f(this.uniform(this.ground, "uExtent"), l.width, l.height), c.uniform1f(this.uniform(this.ground, "uFloor"), d.floor), c.bindVertexArray(this.emptyVAO), c.drawArrays(c.TRIANGLES, 0, 6), c.depthMask(!0)), this.displayMask && (c.enable(c.STENCIL_TEST), c.stencilFunc(c.ALWAYS, 1, 255), c.stencilOp(c.KEEP, c.KEEP, c.REPLACE)), c.enable(c.DEPTH_TEST), c.depthFunc(c.LEQUAL), c.disable(c.CULL_FACE), c.disable(c.BLEND), c.useProgram(this.terrain.program), this.heightUniforms(this.terrain), this.maskUniforms(this.terrain), c.activeTexture(c.TEXTURE1), c.bindTexture(c.TEXTURE_2D, this.normalTexture), c.uniform1i(this.uniform(this.terrain, "uNormal"), 1), c.activeTexture(c.TEXTURE2), c.bindTexture(c.TEXTURE_2D, u.texture), c.uniform1i(this.uniform(this.terrain, "uShadow"), 2), c.activeTexture(c.TEXTURE4), c.bindTexture(c.TEXTURE_2D, this.surfaceTexture), c.uniform1i(this.uniform(this.terrain, "uSurface"), 4), c.activeTexture(c.TEXTURE5), c.bindTexture(c.TEXTURE_2D, this.cartographyTexture), c.uniform1i(this.uniform(this.terrain, "uCartography"), 5), c.uniform2fv(this.uniform(this.terrain, "uCartographySize"), this.cartographySize), c.uniformMatrix4fv(this.uniform(this.terrain, "uMatrix"), !1, t.matrix), c.uniform2fv(this.uniform(this.terrain, "uOffset"), t.offset), c.uniform3fv(this.uniform(this.terrain, "uLight"), n), c.uniform3fv(this.uniform(this.terrain, "uEye"), t.eye), c.uniform1f(this.uniform(this.terrain, "uBase"), l.base), c.uniform1f(this.uniform(this.terrain, "uScale"), l.scale), c.uniform1f(this.uniform(this.terrain, "uShadowTexel"), 1 / u.size), c.bindVertexArray(d.vao), c.drawElements(c.TRIANGLES, d.count, d.type, 0), this.displayMask && (c.stencilMask(0), c.stencilFunc(c.EQUAL, 1, 255), c.stencilOp(c.KEEP, c.KEEP, c.KEEP)), this.displayMask || (c.useProgram(this.boundary.program), c.uniformMatrix4fv(this.uniform(this.boundary, "uMatrix"), !1, t.matrix), c.uniform2fv(this.uniform(this.boundary, "uOffset"), t.offset), c.uniform3fv(this.uniform(this.boundary, "uLight"), n), c.uniform1f(this.uniform(this.boundary, "uFloor"), d.floor), c.bindVertexArray(d.boundaryVAO), c.drawArrays(c.TRIANGLES, 0, d.boundaryCount)), this.routeCount) {
			c.enable(c.BLEND), c.blendFunc(c.SRC_ALPHA, c.ONE_MINUS_SRC_ALPHA), c.depthMask(!1), c.useProgram(this.line.program), c.uniformMatrix4fv(this.uniform(this.line, "uMatrix"), !1, t.matrix), c.uniform2fv(this.uniform(this.line, "uOffset"), t.offset), this.maskUniforms(this.line), c.uniform2f(this.uniform(this.line, "uExtent"), l.width, l.height), c.uniform2f(this.uniform(this.line, "uViewport"), r, a), c.bindVertexArray(this.routeVAO);
			for (let [e, t] of [[4.3, [
				1,
				.985,
				.91,
				.94
			]], [2.25, [
				.74,
				.3,
				.12,
				1
			]]]) c.uniform1f(this.uniform(this.line, "uHalfWidth"), e * o), c.uniform4fv(this.uniform(this.line, "uColor"), t), c.drawArrays(c.TRIANGLES, 0, this.routeCount);
			c.depthMask(!0), c.disable(c.BLEND);
		}
		c.disable(c.STENCIL_TEST), c.bindVertexArray(null), c.flush();
	}
	destroy() {
		let e = this.gl;
		for (let [t, n] of this.resources.reverse()) e["delete" + n](t);
		this.resources = [], this.meshes.clear(), this.shadows.clear();
	}
};
function ce(e) {
	return Z(e);
}
var le = class {
	constructor(e, t, n = null) {
		this.ctx = e, this.model = t, this.displayMask = n, this.shadowCache = /* @__PURE__ */ new Map(), this.boundaries = /* @__PURE__ */ new Map(), this.cartography = null;
	}
	setCartography(e) {
		this.cartography = e;
	}
	shadows(e, t, n) {
		let r = e.step + ":" + n.shadowQueries + ":" + t.join(":");
		if (this.shadowCache.has(r)) return this.shadowCache.get(r);
		let i = new Float32Array(e.count), a = this.model;
		for (let r = 0; r < e.count; r++) i[r] = k(a, (e.uv[r * 2] - .5) * a.widthM, (.5 - e.uv[r * 2 + 1]) * a.heightM, a.grid.elevations[e.sampleIds[r]], t, n.shadowQueries);
		return this.shadowCache.size >= 4 && this.shadowCache.delete(this.shadowCache.keys().next().value), this.shadowCache.set(r, i), i;
	}
	render(e, t, n, r, a, o, s, c) {
		let l = this.model, m = this.ctx;
		(!this.image || this.image.width !== r || this.image.height !== a) && (this.image = m.createImageData(r, a), this.depth = new Float32Array(r * a));
		let h = this.image.data, g = this.depth;
		for (let e = 0; e < h.length; e += 4) h[e] = i[0], h[e + 1] = i[1], h[e + 2] = i[2], h[e + 3] = 255;
		g.fill(Infinity), this.boundaries.has(e.step) || this.boundaries.set(e.step, this.displayMask ? {
			count: 0,
			vertices: /* @__PURE__ */ new Float32Array(),
			floor: 0
		} : R(l, e.step));
		let v = this.boundaries.get(e.step), b = this.shadows(e, n, s), x = Array(e.count + v.count), S = new Float32Array((e.count + v.count) * 3), C = this.cartography, w = C ? new Float32Array(e.count * 3) : null, T = C ? new Float32Array(e.count) : null, E = [
			0,
			0,
			0,
			0
		];
		for (let o = 0; o < e.count; o++) {
			let s = e.sampleIds[o], c = [
				l.normals[s * 3],
				l.normals[s * 3 + 1],
				l.normals[s * 3 + 2]
			], m = e.uv[o * 2], h = e.uv[o * 2 + 1], g = [
				(m - .5) * l.width,
				(.5 - h) * l.height,
				l.heights[s]
			];
			x[o] = K(g, t, r, a);
			let _ = ce(l.grid.elevations[s]), v = f(.18, .57, 1 - c[2]), y = l.normalTexture[s * 4 + 3] / 255, C = Math.max(0, p(c, n)) * b[o] * .94, E = Math.max(u((Math.hypot(...g.map((e, n) => e - t.eye[n])) - .68) * .13, 0, .32), (1 - f(0, .003, Math.min(m, 1 - m, h, 1 - h))) * .15);
			T && (T[o] = E);
			for (let e = 0; e < 3; e++) {
				let t = d(_[e], [
					.57,
					.55,
					.48
				][e], v * .68), n = [
					.34,
					.41,
					.4
				][e] * (.55 + .45 * c[2]) * y + [
					1.05,
					.99,
					.85
				][e] * C;
				S[o * 3 + e] = d(Math.max(0, t ** 2.2 * n) ** (1 / 2.2) * 255, i[e], E), w && (w[o * 3 + e] = Math.max(0, n) ** (1 / 2.2));
			}
		}
		for (let i = 0; i < v.count; i++) {
			let o = i * 6, s = Array.from(v.vertices.subarray(o, o + 3)), c = Array.from(v.vertices.subarray(o + 3, o + 6)), l = e.count + i;
			x[l] = K(s, t, r, a);
			let f = u((s[2] - v.floor) / .17, 0, 1), m = .4 + .6 * Math.max(p(c, n), 0);
			for (let e = 0; e < 3; e++) S[l * 3 + e] = d([
				.34,
				.38,
				.33
			][e], [
				.49,
				.53,
				.46
			][e], f) * m * 255;
		}
		let D = e.indices;
		for (let t = 0; t < D.length + v.count; t += 3) {
			let n = t < D.length ? D[t] : e.count + t - D.length, o = t < D.length ? D[t + 1] : n + 1, s = t < D.length ? D[t + 2] : n + 2, c = x[n], l = x[o], u = x[s];
			if (!c || !l || !u) continue;
			let f = Math.max(0, Math.floor(Math.min(c[0], l[0], u[0]))), p = Math.min(r - 1, Math.ceil(Math.max(c[0], l[0], u[0]))), m = Math.max(0, Math.floor(Math.min(c[1], l[1], u[1]))), v = Math.min(a - 1, Math.ceil(Math.max(c[1], l[1], u[1])));
			if (f > p || m > v) continue;
			let b = (l[1] - u[1]) * (c[0] - u[0]) + (u[0] - l[0]) * (c[1] - u[1]);
			if (Math.abs(b) < 1e-5) continue;
			let O = 1 / b, k = (l[1] - u[1]) * O, A = (u[0] - l[0]) * O, j = (u[1] - c[1]) * O, M = (c[0] - u[0]) * O, N = ((l[1] - u[1]) * (f + .5 - u[0]) + (u[0] - l[0]) * (m + .5 - u[1])) * O, P = ((u[1] - c[1]) * (f + .5 - u[0]) + (c[0] - u[0]) * (m + .5 - u[1])) * O;
			for (let a = m; a <= v; a++, N += A, P += M) {
				let m = N, v = P, b = a * r + f;
				for (let r = f; r <= p; r++, b++, m += k, v += j) {
					let r = 1 - m - v;
					if (m < -1e-5 || v < -1e-5 || r < -1e-5) continue;
					let a = m * c[2] + v * l[2] + r * u[2];
					if (a > g[b] || a < -1 || a > 1) continue;
					let f = m * c[3], p = v * l[3], x = r * u[3], O = 1 / (f + p + x), k = b * 4, A = t < D.length && (C || this.displayMask) ? (f * e.uv[n * 2] + p * e.uv[o * 2] + x * e.uv[s * 2]) * O : 0, j = t < D.length && (C || this.displayMask) ? (f * e.uv[n * 2 + 1] + p * e.uv[o * 2 + 1] + x * e.uv[s * 2 + 1]) * O : 0;
					if (this.displayMask && !_(this.displayMask, A, j)) continue;
					g[b] = a;
					let M = 0, N = 0;
					C && t < D.length && (y(C, A, j, E), M = E[3] / 255, N = (f * T[n] + p * T[o] + x * T[s]) * O);
					for (let e = 0; e < 3; e++) {
						let t = (f * S[n * 3 + e] + p * S[o * 3 + e] + x * S[s * 3 + e]) * O, r = M ? d(E[e] * (f * w[n * 3 + e] + p * w[o * 3 + e] + x * w[s * 3 + e]) * O, i[e], N) : t;
						h[k + e] = d(t, r, M);
					}
				}
			}
		}
		let O = c.map(([e, n]) => [
			K(e, t, r, a),
			K(n, t, r, a),
			[e[0] / l.width + .5, .5 - e[1] / l.height],
			[n[0] / l.width + .5, .5 - n[1] / l.height]
		]);
		for (let [e, t] of [[4.3 * o, [
			255,
			251,
			232
		]], [2.25 * o, [
			189,
			77,
			31
		]]]) for (let [n, i, o, s] of O) n && i && this.routeCapsule(n, i, e, t, r, a, h, g, o, s);
		m.putImageData(this.image, 0, 0);
	}
	routeCapsule(e, t, n, r, i, a, o, s, c, l) {
		let f = t[0] - e[0], p = t[1] - e[1], m = f * f + p * p;
		if (m < 1e-5) return;
		let h = Math.max(0, Math.floor(Math.min(e[0], t[0]) - n)), g = Math.min(i - 1, Math.ceil(Math.max(e[0], t[0]) + n)), v = Math.max(0, Math.floor(Math.min(e[1], t[1]) - n)), y = Math.min(a - 1, Math.ceil(Math.max(e[1], t[1]) + n));
		for (let a = v; a <= y; a++) for (let v = h; v <= g; v++) {
			let h = u(((v + .5 - e[0]) * f + (a + .5 - e[1]) * p) / m, 0, 1), g = Math.hypot(v + .5 - e[0] - f * h, a + .5 - e[1] - p * h);
			if (g >= n) continue;
			let y = a * i + v, b = d(e[2], t[2], h);
			if (b > s[y] || b < -1 || b > 1) continue;
			if (this.displayMask) {
				let n = 1 / d(e[3], t[3], h), r = d(c[0] * e[3], l[0] * t[3], h) * n, i = d(c[1] * e[3], l[1] * t[3], h) * n;
				if (!Number.isFinite(s[y]) || !_(this.displayMask, r, i)) continue;
			}
			let x = u(n - g, 0, 1), S = y * 4;
			for (let e = 0; e < 3; e++) o[S + e] = d(o[S + e], r[e], x);
		}
	}
	destroy() {
		this.shadowCache.clear(), this.boundaries.clear(), this.image = null, this.depth = null, this.cartography = null, this.displayMask = null;
	}
}, ue = class {
	constructor(e, t, n = {}) {
		this.originalCanvas = e, this.canvas = e, this.grid = t, this.options = {
			...n,
			displayMask: void 0
		};
		let i = n.displayMask ? g(n.displayMask, t) : null;
		this.displayMask = i ? {
			width: i.width,
			height: i.height,
			pixels: new Uint8Array(i.pixels),
			source: {
				...i.source,
				bounds: [...i.source.bounds],
				cells: [...i.source.cells]
			}
		} : null, this.model = n.preparedModel === void 0 ? w(t) : E(t, n.preparedModel), this.widthM = this.model.widthM, this.heightM = this.model.heightM, this.base = this.model.base, this.yaw = r.yaw, this.pitch = r.pitch, this.zoom = r.zoom, this.offset = [0, 0], this.viewportInsets = H(n.viewportInsets), this.visible = !0, this.destroyed = !1, this.failed = !1, this.contextLost = !1, this.frame = 0, this.dirty = !0, this.warmRequested = !1, this.pointers = /* @__PURE__ */ new Map(), this.events = [], this.meshes = /* @__PURE__ */ new Map(), this.meshStride = 0, this.renderProfile = null, this.route = [], this.routeMeshes = /* @__PURE__ */ new Map(), this.gpuRoute = null, this.dragging = !1, this.wheeling = !1, this.cartography = null, this.previousTouchAction = e.style?.touchAction, e.style && (e.style.touchAction = "none");
		try {
			let t;
			if (!n.forceCanvas) try {
				t = e.getContext("webgl2", {
					alpha: !1,
					antialias: !0,
					depth: !0,
					stencil: !!this.displayMask,
					preserveDrawingBuffer: !1,
					powerPreference: "default",
					failIfMajorPerformanceCaveat: !0
				});
			} catch {}
			if (t) try {
				this.gpu = new $(t, this.model, this.displayMask), this.gl = t;
			} catch {
				t.getExtension("WEBGL_lose_context")?.loseContext(), this.useCanvas(!0);
			}
			else this.useCanvas(!1);
			this.bindControls(), this.observe(), this.document = e.ownerDocument || (typeof document < "u" ? document : null), this.onVisibility = () => {
				this.document?.visibilityState === "hidden" ? this.cancelFrame() : this.request();
			}, this.document?.addEventListener("visibilitychange", this.onVisibility), this.request();
		} catch (e) {
			throw this.destroy(), e;
		}
	}
	useCanvas(e) {
		let t = this.canvas;
		if (e && (t = this.canvas.cloneNode?.(!1), !t || !this.canvas.parentNode)) throw Error("Аппаратная сцена недоступна. Откройте плоскую карту.");
		let n = t.getContext("2d", { alpha: !1 });
		if (!n) throw Error("На этом устройстве недоступен рендер карты.");
		e && (this.canvas.parentNode.replaceChild(t, this.canvas), this.canvas = t), this.software = new le(n, this.model, this.displayMask), this.software.setCartography(this.cartography), this.gl = null, this.gpu = null;
	}
	notify(e, t) {
		try {
			this.options[e]?.(t);
		} catch {}
	}
	bind(e, t, n) {
		this.canvas.addEventListener(e, t, n), this.events.push([
			this.canvas,
			e,
			t,
			n
		]);
	}
	bindControls() {
		this.bind("pointerdown", (e) => {
			if (!(e.button !== void 0 && ![
				0,
				1,
				2
			].includes(e.button))) {
				try {
					this.canvas.setPointerCapture(e.pointerId);
				} catch {}
				this.pointers.set(e.pointerId, {
					x: e.clientX,
					y: e.clientY,
					pan: e.button === 1 || e.button === 2 || e.shiftKey
				}), this.dragging = !0, this.request();
			}
		}), this.bind("pointermove", (n) => {
			let r = this.pointers.get(n.pointerId);
			if (!r) return;
			let i = [...this.pointers.values()];
			this.pointers.set(n.pointerId, {
				...r,
				x: n.clientX,
				y: n.clientY
			});
			let a = [...this.pointers.values()];
			if (a.length === 1) r.pan ? this.panBy(n.clientX - r.x, n.clientY - r.y) : (this.yaw += (n.clientX - r.x) * .0045, this.pitch = u(this.pitch + (n.clientY - r.y) * .003, .28, 1.32));
			else if (a.length === 2) {
				let e = Math.hypot(i[0].x - i[1].x, i[0].y - i[1].y), t = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
				e > 2 && (this.zoom = u(this.zoom * t / e, .65, 5)), this.panBy((a[0].x + a[1].x - i[0].x - i[1].x) / 2, (a[0].y + a[1].y - i[0].y - i[1].y) / 2);
			}
			this.yaw = ((this.yaw + e) % t + t) % t - e, this.request();
		});
		let n = (e) => {
			this.pointers.delete(e.pointerId);
			try {
				this.canvas.hasPointerCapture?.(e.pointerId) && this.canvas.releasePointerCapture(e.pointerId);
			} catch {}
			this.dragging = this.pointers.size > 0, this.request();
		};
		this.bind("pointerup", n), this.bind("pointercancel", n), this.bind("lostpointercapture", n), this.bind("contextmenu", (e) => e.preventDefault()), this.bind("wheel", (e) => {
			e.preventDefault();
			let t = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1;
			this.zoom = u(this.zoom * Math.exp(-u(e.deltaY * t, -800, 800) * .001), .65, 5), this.wheeling = !0, clearTimeout(this.wheelTimer), this.wheelTimer = setTimeout(() => {
				this.wheeling = !1, this.request();
			}, 140), this.request();
		}, { passive: !1 }), this.bind("keydown", (e) => {
			if (e.key === "ArrowLeft") this.rotate(-.1);
			else if (e.key === "ArrowRight") this.rotate(.1);
			else if (e.key === "ArrowUp") this.pitch = u(this.pitch + .06, .28, 1.32), this.request();
			else if (e.key === "ArrowDown") this.pitch = u(this.pitch - .06, .28, 1.32), this.request();
			else if (e.key === "+" || e.key === "=") this.zoomBy(1.15);
			else if (e.key === "-" || e.key === "−") this.zoomBy(1 / 1.15);
			else if (e.key === "Home") this.reset();
			else return;
			e.preventDefault();
		}), this.bind("webglcontextlost", (e) => {
			e.preventDefault(), this.contextLost = !0, this.cancelFrame(), this.notify("onError", "Графический контекст прерван. Восстанавливаем сцену…"), clearTimeout(this.restoreTimer), this.restoreTimer = setTimeout(() => this.fallbackAfterLoss(), 2500);
		}), this.bind("webglcontextrestored", () => {
			if (!(this.destroyed || !this.gl)) {
				clearTimeout(this.restoreTimer);
				try {
					this.gpu?.destroy(), this.gpu = new $(this.gl, this.model, this.displayMask), this.gpu.setCartography(this.cartography), this.gpuRoute = null, this.contextLost = !1, this.request();
				} catch {
					this.fallbackAfterLoss();
				}
			}
		});
	}
	fallbackAfterLoss() {
		if (!(this.destroyed || !this.contextLost)) {
			clearTimeout(this.restoreTimer), this.unbindControls(), this.resize?.disconnect(), this.pointers.clear(), this.dragging = !1, this.wheeling = !1, clearTimeout(this.wheelTimer), this.gpuRoute = null;
			try {
				this.gpu?.destroy(), this.useCanvas(!0), this.contextLost = !1, this.bindControls(), this.observe(), this.request();
			} catch {
				this.terminalFailure("Не удалось восстановить ландшафт. Подготовьте сцену заново.");
			}
		}
	}
	terminalFailure(e) {
		this.destroyed || (this.failed = !0, this.destroy(), this.notify("onError", e), this.notify("onFatal", e));
	}
	unbindControls() {
		this.events.forEach(([e, t, n, r]) => e.removeEventListener(t, n, r)), this.events = [];
	}
	observe() {
		typeof ResizeObserver < "u" ? (this.resize = new ResizeObserver(() => this.request()), this.resize.observe(this.canvas)) : typeof window < "u" && !this.onResize && (this.onResize = () => this.request(), window.addEventListener("resize", this.onResize));
	}
	panBy(e, t) {
		let n = this.canvas.getBoundingClientRect(), r = 1 / Math.max(200, Math.min(n.width, n.height)) / this.zoom, i = Math.cos(this.yaw), a = Math.sin(this.yaw);
		this.offset[0] = u(this.offset[0] - (e * i + t * a) * r, -this.model.width * .42, this.model.width * .42), this.offset[1] = u(this.offset[1] - (e * a - t * i) * r, -this.model.height * .42, this.model.height * .42);
	}
	heightAt(e, t) {
		return A(this.model, e, t);
	}
	setCartography(e) {
		if (this.destroyed) return;
		e && v(e, this.grid);
		let t = e && e.source.loadedTiles > 0 ? {
			width: e.width,
			height: e.height,
			pixels: new Uint8ClampedArray(e.pixels),
			source: {
				...e.source,
				bounds: [...e.source.bounds]
			}
		} : null;
		this.cartography = t, this.software?.setCartography(t), this.canvas.dataset.cartography = t && t.source.loadedTiles > 0 ? "source" : "none", this.canvas.dataset.cartographyTiles = String(t?.source.loadedTiles || 0);
		try {
			this.gpu && !this.contextLost && this.gpu.setCartography(t);
		} catch {
			this.contextLost = !0, this.fallbackAfterLoss();
			return;
		}
		this.request();
	}
	setGeometry(e) {
		if (!this.destroyed) try {
			let t = B(this.model, e);
			return this.route = t.segments, this.routeMeshes.clear(), this.gpuRoute = null, this.canvas.dataset.routeClipped = String(t.clipped), this.canvas.dataset.routeSegments = String(t.segments.length), this.request(), {
				segments: t.segments.length,
				clipped: t.clipped
			};
		} catch {
			return this.route = [], this.routeMeshes.clear(), this.gpuRoute = null, this.request(), this.notify("onError", "Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте."), this.canvas.dataset.routeClipped = "true", this.canvas.dataset.routeSegments = "0", {
				segments: 0,
				clipped: !0
			};
		}
	}
	setVisible(e) {
		this.visible = !!e, this.visible ? this.request() : (this.cancelFrame(), this.pointers.clear(), this.dragging = !1, this.wheeling = !1, clearTimeout(this.wheelTimer), this.warmRequested && this.request());
	}
	setViewportInsets(e) {
		this.destroyed || (this.viewportInsets = H(e), this.request());
	}
	warmup() {
		this.destroyed || (this.warmRequested = !0, this.request());
	}
	cancelFrame() {
		this.frame &&= (cancelAnimationFrame(this.frame), 0);
	}
	request() {
		this.dirty = !0, !(this.destroyed || !this.visible && !this.warmRequested || this.contextLost || this.frame || this.document?.visibilityState === "hidden") && (this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			let e = this.warmRequested;
			this.warmRequested = !1, !this.destroyed && (this.visible || e) && !this.contextLost && this.document?.visibilityState !== "hidden" && (this.dirty = !1, this.render(e));
		}));
	}
	meshFor(e) {
		return this.meshes.has(e) || this.meshes.set(e, F(this.model, e)), this.meshes.get(e);
	}
	profileFor(e, t) {
		let n = t.deviceMemory !== void 0 && t.deviceMemory < 4, r = n || e.width < 700, i = !!this.gpu + ":" + n + ":" + r;
		return this.renderProfile?.key !== i && (this.renderProfile = {
			key: i,
			pixelLimit: this.gpu ? n ? 16e5 : 28e5 : 9e5,
			maxDpr: this.gpu ? 2 : 1.5,
			vertexLimit: this.gpu ? n ? 66049 : 263169 : 16641,
			shadowSize: r ? 128 : 256,
			shadowQueries: r ? s : c
		}), this.renderProfile;
	}
	routeFor(e) {
		if (this.routeMeshes.has(e)) return this.routeMeshes.get(e);
		let t;
		try {
			t = P(this.model, this.route, e);
		} catch {
			t = [], this.notify("onError", "Геометрия не помещается в предпросмотр. Откройте маршрут на основной карте.");
		}
		return this.routeMeshes.size >= 2 && this.routeMeshes.delete(this.routeMeshes.keys().next().value), this.routeMeshes.set(e, t), t;
	}
	render(e = !1) {
		let t = performance.now(), n = this.canvas.getBoundingClientRect();
		if (n.width < 1 || n.height < 1) {
			e && (this.warmRequested = !0);
			return;
		}
		let r = this.dragging || this.wheeling, i = typeof navigator < "u" ? navigator : {}, a = this.profileFor(n, i), o = Math.min(typeof devicePixelRatio == "number" ? devicePixelRatio : 1, a.maxDpr), s = Math.min(o, Math.sqrt(a.pixelLimit / (n.width * n.height)), 4096 / n.width, 4096 / n.height), c = Math.max(1, Math.round(n.width * s)), l = Math.max(1, Math.round(n.height * s));
		(this.canvas.width !== c || this.canvas.height !== l) && (this.canvas.width = c, this.canvas.height = l);
		let u = G(this.model, this, n.width, n.height, this.options.compactViewport), d = this.gpu ? Math.max(4225, u.usableW * u.usableH * .55 * Math.min(2, this.zoom)) : 16641, f = I(this.grid, d, this.meshStride, a.vertexLimit);
		this.meshStride = f;
		let p = this.meshFor(f), m = L(this.yaw, this.pitch), h = this.routeFor(f);
		try {
			this.gpu ? (this.gpuRoute !== h && (this.gpu.setRoute(h), this.gpuRoute = h), this.gpu.render(p, u, m, c, l, s, a)) : this.software.render(p, u, m, c, l, s, a, h);
		} catch {
			if (this.gpu) {
				this.warmRequested = e, this.contextLost = !0, this.fallbackAfterLoss();
				return;
			}
			this.terminalFailure("Не удалось нарисовать ландшафт. Подготовьте сцену заново.");
			return;
		}
		let g = performance.now() - t, _ = this.gpu ? "webgl2" : "canvas2d", v = r ? "motion" : "full";
		this.canvas.dataset.renderMs = g.toFixed(1), this.canvas.dataset.triangles = String(p.triangles), this.canvas.dataset.quality = v, this.canvas.dataset.renderer = _, this.canvas.dataset.meshStride = String(f), this.canvas.dataset.routeMeshStride = String(f), this.canvas.dataset.routeRenderSegments = String(h.length), this.canvas.dataset.sourceVertices = String(this.grid.width * this.grid.height), this.canvas.dataset.heightScale = "1", this.canvas.dataset.material = "cartographic", this.canvas.dataset.displayMask = this.displayMask ? "russia-display-area" : "none", this.notify("onRender", {
			ms: g,
			triangles: p.triangles,
			quality: v,
			renderer: _,
			pixelRatio: s,
			meshStride: f,
			sourceVertices: this.grid.width * this.grid.height,
			view: {
				yaw: this.yaw,
				pitch: this.pitch,
				zoom: this.zoom,
				offset: [...this.offset]
			},
			cartography: this.cartography ? {
				loadedTiles: this.cartography.source.loadedTiles,
				requestedTiles: this.cartography.source.requestedTiles,
				width: this.cartography.width,
				height: this.cartography.height
			} : null,
			displayMask: this.displayMask ? {
				width: this.displayMask.width,
				height: this.displayMask.height,
				allowedPixels: this.displayMask.source.allowedPixels,
				coverageVersion: this.displayMask.source.coverageVersion
			} : null
		});
	}
	rotate(n) {
		this.destroyed || !Number.isFinite(n) || (this.yaw = ((this.yaw + n + e) % t + t) % t - e, this.request());
	}
	zoomBy(e) {
		this.destroyed || !Number.isFinite(e) || e <= 0 || (this.zoom = u(this.zoom * e, .65, 5), this.request());
	}
	reset() {
		this.destroyed || (this.yaw = r.yaw, this.pitch = r.pitch, this.zoom = r.zoom, this.offset = [0, 0], this.request());
	}
	destroy() {
		this.destroyed || (this.destroyed = !0, this.cancelFrame(), clearTimeout(this.wheelTimer), clearTimeout(this.restoreTimer), this.resize?.disconnect(), this.onResize && typeof window < "u" && window.removeEventListener("resize", this.onResize), this.document?.removeEventListener("visibilitychange", this.onVisibility), this.unbindControls(), this.pointers.clear(), this.gpu?.destroy(), this.software?.destroy(), this.meshes.clear(), this.routeMeshes.clear(), this.route = [], this.gpuRoute = null, this.cartography = null, this.displayMask = null, this.warmRequested = !1, this.canvas !== this.originalCanvas && this.canvas.parentNode && this.canvas.parentNode.replaceChild(this.originalCanvas, this.canvas), this.originalCanvas.style && (this.originalCanvas.style.touchAction = this.previousTouchAction || ""));
	}
};
//#endregion
export { ue as TerrainRenderer, R as buildTerrainBoundary, F as buildTerrainMesh, z as clipTerrainSegment, X as createSurfaceTexture, w as createTerrainModel, T as createTerrainModelAsync, P as drapeTerrainRoute, A as sampleElevation, y as sampleTerrainCartography, _ as sampleTerrainDisplayMask, N as sampleTerrainMeshElevation, k as sampleTerrainShadow, I as selectTerrainMeshStride, Y as surfaceNoise, L as terrainLight, Z as terrainMaterialColor, B as terrainRoute, E as validatePreparedTerrainModel, v as validateTerrainCartography, g as validateTerrainDisplayMask, b as validateTerrainGrid };
