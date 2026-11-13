var e = 85.0511287798066, t = Math.PI / 180, n = 89.999999, r = (e, t, n) => Math.min(n, Math.max(t, e)), i = (e, t) => {
	if (!Number.isFinite(e)) throw RangeError(`${t} must be finite`);
	return e;
};
function a(e) {
	i(e.x, "x"), i(e.y, "y");
}
function o(e) {
	if (!(i(e.width, "width") > 0) || !(i(e.height, "height") > 0)) throw RangeError("Viewport must have positive dimensions");
}
function s(e) {
	let t = 256 * 2 ** i(e, "zoom");
	if (!Number.isFinite(t) || t <= 0) throw RangeError("Zoom exceeds numeric projection range");
	return t;
}
function c(e = 0) {
	return ((i(e, "bearing") + 180) % 360 + 360) % 360 - 180;
}
function l(e, t) {
	return i(e, "longitude"), i(t, "reference longitude"), e + 360 * Math.round((t - e) / 360);
}
function u(e, n) {
	let a = i(e[0], "longitude"), o = r(i(e[1], "latitude"), -n, n);
	return {
		x: (a + 180) / 360,
		y: (1 - Math.asinh(Math.tan(o * t)) / Math.PI) / 2
	};
}
function d(t) {
	return u(t, e);
}
function f(e) {
	return a(e), [e.x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * e.y))) / t];
}
function p(e, r) {
	o(r);
	let i = c(e.bearingDegrees) * t;
	return {
		center: u(e.center, n),
		scale: s(e.zoom),
		cosine: Math.cos(i),
		sine: Math.sin(i),
		viewport: r
	};
}
function m(e, t) {
	let n = (e.x - t.center.x) * t.scale, r = (e.y - t.center.y) * t.scale;
	return {
		x: t.viewport.width / 2 + t.cosine * n + t.sine * r,
		y: t.viewport.height / 2 - t.sine * n + t.cosine * r
	};
}
function h(e, t) {
	let n = e.x - t.viewport.width / 2, r = e.y - t.viewport.height / 2;
	return {
		x: t.center.x + (t.cosine * n - t.sine * r) / t.scale,
		y: t.center.y + (t.sine * n + t.cosine * r) / t.scale
	};
}
function g(e, t, n, r = {}) {
	let i = d(n), a = p(e, t);
	return r.wrapLongitude !== !1 && (i.x += Math.round(a.center.x - i.x)), m(i, a);
}
function _(e, t, n) {
	return a(n), f(h(n, p(e, t)));
}
function v(e, t) {
	let n = t.minZoom ?? -Infinity, a = t.maxZoom ?? Infinity;
	if (Number.isNaN(n) || Number.isNaN(a) || n > a) throw RangeError("Invalid zoom limits");
	let o = r(i(e, "zoom"), n, a);
	return s(o), o;
}
function y(e, t, i) {
	let a = u([0, n], n).y;
	return {
		center: f({
			x: e.x,
			y: r(e.y, a, 1 - a)
		}),
		zoom: t,
		bearingDegrees: c(i)
	};
}
function b(e, r) {
	a(r);
	let i = c(e.bearingDegrees) * t, o = s(e.zoom), l = u(e.center, n);
	return y({
		x: l.x - (Math.cos(i) * r.x - Math.sin(i) * r.y) / o,
		y: l.y - (Math.sin(i) * r.x + Math.cos(i) * r.y) / o
	}, e.zoom, e.bearingDegrees ?? 0);
}
function x(e, n, r, i, a) {
	let o = c(a) * t, l = s(i), u = n.x - r.width / 2, d = n.y - r.height / 2;
	return y({
		x: e.x - (Math.cos(o) * u - Math.sin(o) * d) / l,
		y: e.y - (Math.sin(o) * u + Math.cos(o) * d) / l
	}, i, a);
}
function S(e, t, n, r = {
	x: t.width / 2,
	y: t.height / 2
}, i = {}) {
	return a(r), x(h(r, p(e, t)), r, t, v(n, i), e.bearingDegrees ?? 0);
}
function ee(e) {
	let t = typeof e == "number" ? {
		top: e,
		right: e,
		bottom: e,
		left: e
	} : e ?? {}, n = {
		top: t.top ?? 0,
		right: t.right ?? 0,
		bottom: t.bottom ?? 0,
		left: t.left ?? 0
	};
	for (let [e, t] of Object.entries(n)) if (i(t, e) < 0) throw RangeError("Map insets cannot be negative");
	return n;
}
function te(t, n) {
	let [a, o, s, c] = t;
	for (let e of t) i(e, "bounds");
	if (o > c) throw RangeError("South must not exceed north");
	if (s < a && (s += 360 * Math.ceil((a - s) / 360)), n !== void 0) {
		let e = l((a + s) / 2, n) - (a + s) / 2;
		a += e, s += e;
	}
	return o = r(o, -85.0511287798066, e), c = r(c, -85.0511287798066, e), [
		a,
		o,
		s,
		c
	];
}
function C(e, n, r = {}) {
	o(n);
	let i = ee(r.padding), a = n.width - i.left - i.right, s = n.height - i.top - i.bottom;
	if (a <= 0 || s <= 0) throw RangeError("Insets leave no map viewport");
	let [l, u, f, p] = te(e, r.referenceLongitude), m = d([l, u]), h = d([f, p]), g = {
		x: (m.x + h.x) / 2,
		y: (m.y + h.y) / 2
	}, _ = c(r.bearingDegrees), y = _ * t, b = Math.abs(Math.cos(y)) * (h.x - m.x) + Math.abs(Math.sin(y)) * (m.y - h.y), S = Math.abs(Math.sin(y)) * (h.x - m.x) + Math.abs(Math.cos(y)) * (m.y - h.y), C = Math.min(b > 0 ? a / b : Infinity, S > 0 ? s / S : Infinity), w = r.maxZoom ?? 18, ne = v(Number.isFinite(C) ? Math.log2(C / 256) : w, {
		...r,
		maxZoom: w
	});
	return x(g, {
		x: i.left + a / 2,
		y: i.top + s / 2
	}, n, ne, _);
}
function w(e, t, n) {
	let r = p(e, t), i = ee(n), a = i.left, o = t.width - i.right, s = i.top, c = t.height - i.bottom;
	if (o <= a || c <= s) throw RangeError("Insets leave no map viewport");
	let l = [
		{
			x: a,
			y: s
		},
		{
			x: o,
			y: s
		},
		{
			x: o,
			y: c
		},
		{
			x: a,
			y: c
		}
	].map((e) => f(h(e, r)));
	return [
		Math.min(...l.map((e) => e[0])),
		Math.min(...l.map((e) => e[1])),
		Math.max(...l.map((e) => e[0])),
		Math.max(...l.map((e) => e[1]))
	];
}
var ne = (e) => ({
	x: (e[0].x + e[1].x) / 2,
	y: (e[0].y + e[1].y) / 2
}), re = (e) => Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y);
function ie(e, n, r, i, o = {}, s = !1) {
	[...r, ...i].forEach(a);
	let l = h(ne(r), p(e, n)), u = re(r), d = re(i), f = u >= 1 && d >= 1 ? d / u : 1, m = v(e.zoom + Math.log2(f), o), g = s && u >= 1 && d >= 1 ? c((Math.atan2(i[1].y - i[0].y, i[1].x - i[0].x) - Math.atan2(r[1].y - r[0].y, r[1].x - r[0].x)) / t) : 0;
	return x(l, ne(i), n, m, (e.bearingDegrees ?? 0) - g);
}
var ae = class {
	constructor(e = {}) {
		this.contacts = /* @__PURE__ */ new Map(), this.options = { ...e };
	}
	get activePointers() {
		return this.contacts.size;
	}
	begin(e, t, n, r) {
		i(e, "pointer id"), a(t), p(n, r), this.contacts.set(e, { ...t }), this.current = {
			...n,
			center: [...n.center]
		}, this.viewport = { ...r }, this.rebase();
	}
	move(e, t) {
		if (!this.contacts.has(e) || !this.basis) return;
		a(t), this.contacts.set(e, { ...t });
		let { camera: n, viewport: r, contacts: i } = this.basis;
		if (i.some((t) => t.id === e)) {
			if (i.length === 1) {
				let e = i[0].point, t = this.contacts.get(i[0].id);
				this.current = b(n, {
					x: t.x - e.x,
					y: t.y - e.y
				});
			} else this.current = ie(n, r, [i[0].point, i[1].point], [this.contacts.get(i[0].id), this.contacts.get(i[1].id)], this.options, this.options.rotate);
			return {
				...this.current,
				center: [...this.current.center]
			};
		}
	}
	end(e) {
		if (this.contacts.delete(e)) {
			if (!this.contacts.size) {
				this.cancel();
				return;
			}
			this.rebase();
		}
	}
	cancel() {
		this.contacts.clear(), this.basis = void 0, this.current = void 0, this.viewport = void 0;
	}
	rebase() {
		!this.current || !this.viewport || (this.basis = {
			camera: {
				...this.current,
				center: [...this.current.center]
			},
			viewport: { ...this.viewport },
			contacts: [...this.contacts].slice(0, 2).map(([e, t]) => ({
				id: e,
				point: { ...t }
			}))
		});
	}
};
function oe(e, t = 0, n = 800, r = 16) {
	if (i(e, "wheel delta"), t === 0) return e;
	let a = t === 1 ? r : t === 2 ? n : NaN;
	if (!Number.isFinite(a) || a <= 0) throw RangeError("Invalid wheel mode or dimensions");
	return e * a;
}
function se(e, t = 0, n = 800, r = 480) {
	if (!(i(r, "pixels per zoom") > 0)) throw RangeError("Wheel zoom sensitivity must be positive");
	return -oe(e, t, n) / r;
}
function ce(e, t, n, r = {}) {
	let a = i(r.panPixels ?? 80, "keyboard pan"), o = i(r.zoomStep ?? 1, "keyboard zoom");
	if (a < 0 || o < 0) throw RangeError("Keyboard steps cannot be negative");
	let s = {
		ArrowLeft: {
			x: a,
			y: 0
		},
		ArrowRight: {
			x: -a,
			y: 0
		},
		ArrowUp: {
			x: 0,
			y: a
		},
		ArrowDown: {
			x: 0,
			y: -a
		}
	};
	if (s[n]) return b(e, s[n]);
	if ([
		"+",
		"=",
		"Add",
		"PageUp"
	].includes(n)) return S(e, t, e.zoom + o, r.anchor, r);
	if ([
		"-",
		"−",
		"Subtract",
		"PageDown"
	].includes(n)) return S(e, t, e.zoom - o, r.anchor, r);
}
function le(e, t, n) {
	let i = n.x - t.x, a = n.y - t.y, o = i * i + a * a, s = o ? r(((e.x - t.x) * i + (e.y - t.y) * a) / o, 0, 1) : 0, c = {
		x: t.x + i * s,
		y: t.y + a * s
	};
	return {
		distance: Math.hypot(e.x - c.x, e.y - c.y),
		fraction: s,
		point: c
	};
}
Object.freeze({
	trailHitRadiusPx: 22,
	regionQueryTolerancePx: 3,
	detailEnterZoom: 4.6,
	detailExitZoom: 3.8,
	territoryMaxZoom: 11,
	clusterZoomStep: 1,
	routeMaxZoom: 14,
	planMaxZoom: 16,
	viewportRegionMinZoom: 4,
	maxPixelRatio: 2,
	prefetchTiles: 12,
	constrainedPrefetchTiles: 4,
	geolocationTimeoutMs: 15e3,
	geolocationMaximumAgeMs: 1e4
});
var ue = Object.freeze({
	concurrency: 3,
	maxBytes: 24 * 1024 * 1024,
	maxResourceBytes: 8 * 1024 * 1024,
	maxQueued: 72,
	timeoutMs: 15e3
}), de = /^https:\/\/(?:tiles\.openfreemap\.org\/(?:[^/?#]+\/)+\d+\/\d+\/\d+\.pbf|tiles\.mapterhorn\.com\/\d+\/\d+\/\d+\.webp|tiles\.maps\.eox\.at\/wmts\/1\.0\.0\/(?:s2cloudless_3857|bluemarble_3857)\/default\/g\/\d+\/\d+\/\d+\.jpg)$/;
function fe(e) {
	return new Promise((t, n) => {
		e.throwIfAborted();
		let r = () => {
			clearTimeout(i), e.removeEventListener("abort", r), n(e.reason);
		}, i = setTimeout(() => {
			e.removeEventListener("abort", r), t();
		}, 150);
		e.addEventListener("abort", r, { once: !0 }), e.aborted && r();
	});
}
var pe = class extends Error {
	constructor(e) {
		super(`Preview resource unavailable (${e})`), this.name = "MapResourceHTTPError", this.status = e;
	}
}, me = class {
	constructor(e = {}) {
		this.entries = /* @__PURE__ */ new Map(), this.queue = [], this.active = 0, this.bytes = 0, this.reloads = /* @__PURE__ */ new Set(), this.options = {
			...ue,
			fetcher: (...e) => fetch(...e),
			...e
		};
		for (let e of [
			"concurrency",
			"maxBytes",
			"maxResourceBytes",
			"maxQueued",
			"timeoutMs"
		]) if (!Number.isSafeInteger(this.options[e]) || this.options[e] <= 0) throw RangeError(`Invalid map resource limit: ${e}`);
	}
	get(e, t = 1, n) {
		if (n?.aborted) return Promise.reject(n.reason ?? new DOMException("Map request cancelled", "AbortError"));
		let r = this.entries.get(e);
		if (r) return r.priority = Math.min(r.priority, t), this.entries.delete(e), this.entries.set(e, r), this.consume(e, r, n);
		if (this.queue.length >= this.options.maxQueued) {
			let e = this.queue.findLast((e) => (this.entries.get(e)?.priority ?? 0) > t);
			if (!e) return Promise.reject(/* @__PURE__ */ Error("Preview queue is full"));
			this.queue.splice(this.queue.indexOf(e), 1), this.entries.get(e)?.reject(/* @__PURE__ */ Error("Preview superseded by an opened map")), this.remove(e);
		}
		let i, a, o = {
			promise: new Promise((e, t) => {
				i = e, a = t;
			}),
			resolve: i,
			reject: a,
			priority: t,
			bytes: 0,
			settled: !1,
			persistent: !1,
			consumers: 0,
			reload: this.reloads.has(e)
		};
		this.entries.set(e, o);
		let s = this.consume(e, o, n);
		return this.queue.push(e), this.pump(), s;
	}
	consume(e, t, n) {
		return n ? (t.consumers++, new Promise((r, i) => {
			let a = !1, o = () => a ? !1 : (a = !0, n.removeEventListener("abort", s), t.consumers--, !0), s = () => {
				if (!o()) return;
				let r = n.reason ?? new DOMException("Map request cancelled", "AbortError");
				i(r), !t.settled && !t.persistent && !t.consumers && this.entries.get(e) === t && (this.queue = this.queue.filter((t) => t !== e), this.remove(e), t.controller?.abort(), t.reject(r));
			};
			n.addEventListener("abort", s, { once: !0 }), t.promise.then((e) => {
				o() && r(e);
			}, (e) => {
				o() && i(e);
			}), n.aborted && s();
		})) : (t.persistent = !0, t.promise);
	}
	has(e) {
		return this.entries.has(e);
	}
	invalidate(e, t = {}) {
		this.entries.get(e)?.settled && this.remove(e), t.reload && (this.reloads.delete(e), this.reloads.add(e), this.reloads.size > this.options.maxQueued && this.reloads.delete(this.reloads.values().next().value));
	}
	async json(e, t = 1) {
		let n = await this.get(e, t), r = this.entries.get(e);
		if (r?.json !== void 0) return r.json;
		try {
			let e = JSON.parse(new TextDecoder().decode(n));
			return r && (r.json = e), e;
		} catch (t) {
			throw this.invalidate(e, { reload: !0 }), t;
		}
	}
	remove(e) {
		let t = this.entries.get(e);
		t && (this.bytes -= t.bytes, this.entries.delete(e));
	}
	pump() {
		for (this.queue.sort((e, t) => (this.entries.get(e)?.priority ?? 9) - (this.entries.get(t)?.priority ?? 9)); this.active < this.options.concurrency && this.queue.length;) {
			let e = this.queue.shift(), t = this.entries.get(e);
			if (!t) continue;
			this.active++;
			let n = new AbortController();
			t.controller = n, this.read(e, n, t.reload).then((n) => {
				if (this.entries.get(e) === t) {
					t.bytes = n.byteLength, t.settled = !0, this.bytes += t.bytes, this.reloads.delete(e);
					for (let [t, n] of this.entries) {
						if (this.bytes <= this.options.maxBytes) break;
						n.settled && t !== e && this.remove(t);
					}
					t.resolve(n);
				}
			}, (n) => {
				this.entries.get(e) === t && this.remove(e), t.reject(n);
			}).finally(() => {
				t.controller = void 0, this.active--, this.pump();
			});
		}
	}
	async read(e, t, n) {
		let r = setTimeout(() => t.abort(), this.options.timeoutMs);
		try {
			let r = /(?:^|\/)terrain-regions\//.test(e);
			for (let i = 0;; i++) {
				t.signal.throwIfAborted();
				let a, o = !1, s = (e) => e.catch((e) => {
					throw o = e instanceof TypeError, e;
				});
				try {
					let i = await s(this.options.fetcher(e, {
						cache: n ? "reload" : r ? "no-cache" : "force-cache",
						credentials: e.startsWith("/") ? "same-origin" : "omit",
						signal: t.signal
					}));
					if (!i.ok) throw new pe(i.status);
					if (Number(i.headers.get("content-length") || 0) > this.options.maxResourceBytes) throw Error("Preview resource exceeds the byte budget");
					if (a = i.body?.getReader(), !a) return /* @__PURE__ */ new ArrayBuffer(0);
					let o = [], c = 0;
					for (;;) {
						let { value: e, done: t } = await s(a.read());
						if (t) break;
						if (c += e.byteLength, c > this.options.maxResourceBytes) throw Error("Preview resource exceeds the byte budget");
						o.push(e);
					}
					let l = new Uint8Array(c), u = 0;
					for (let e of o) l.set(e, u), u += e.length;
					return l.buffer;
				} catch (n) {
					if (i || t.signal.aborted || !o || !de.test(e)) throw t.abort(), n;
				} finally {
					await a?.cancel().catch(() => {}), a?.releaseLock();
				}
				await fe(t.signal);
			}
		} finally {
			clearTimeout(r), t.abort();
		}
	}
	stats() {
		return {
			active: this.active,
			queued: this.queue.length,
			cached: this.entries.size,
			bytes: this.bytes
		};
	}
};
//#endregion
//#region web/lib/map-transport.ts
function he(e, t = "https://map-preview.local") {
	try {
		if (e.startsWith("//")) return null;
		let n = new URL(t), r = new URL(e, n);
		return r.username || r.password || r.hash || /%2f|%5c|%00/i.test(r.pathname) ? null : r.origin === n.origin && [
			"/data/",
			"/maps/",
			"/terrain/",
			"/terrain-regions/",
			"/offline-map/"
		].some((e) => r.pathname.startsWith(e)) ? r.pathname + r.search : r.protocol === "https:" && !r.port && ["tiles.openfreemap.org", "tiles.mapterhorn.com"].includes(r.hostname) || r.protocol === "https:" && !r.port && r.hostname === "tiles.maps.eox.at" && !r.search && /^\/wmts\/1\.0\.0\/(s2cloudless_3857|bluemarble_3857)\/default\/g\/\d+\/\d+\/\d+\.jpg$/.test(r.pathname) ? r.href : null;
	} catch {
		return null;
	}
}
//#endregion
//#region web/lib/route-geometry.ts
var T = (e) => !!e && typeof e == "object" && !Array.isArray(e), ge = (e) => Array.isArray(e) && e.length >= 2 && e.every((e) => typeof e == "number" && Number.isFinite(e));
function E(e, t) {
	return t === 0 ? ge(e) : Array.isArray(e) && e.every((e) => E(e, t - 1));
}
function D(e, t = 0) {
	if (!T(e) || t > 16) return !1;
	switch (e.type) {
		case "Point": return E(e.coordinates, 0);
		case "MultiPoint":
		case "LineString": return E(e.coordinates, 1);
		case "MultiLineString":
		case "Polygon": return E(e.coordinates, 2);
		case "MultiPolygon": return E(e.coordinates, 3);
		case "GeometryCollection": return Array.isArray(e.geometries) && e.geometries.every((e) => D(e, t + 1));
		default: return !1;
	}
}
function _e(e) {
	return T(e) && e.type === "Feature" && (e.geometry === null || D(e.geometry)) && (e.properties === void 0 || e.properties === null || T(e.properties));
}
function O(e) {
	let t = T(e) && T(e.data) && "geometry" in e.data ? e.data.geometry : e;
	if (!T(t) || !(t.type === "FeatureCollection" ? Array.isArray(t.features) && t.features.every(_e) : t.type === "Feature" ? _e(t) : D(t))) throw Error("Invalid route geometry");
	return t;
}
//#endregion
//#region web/public/maps/russia-viewport.js
var ve = [[19.6389282, 41.1858711], [191.0026658, 81.858721]], ye = "#e7ebe2", k = (e, t, n) => Math.max(t, Math.min(n, e));
function A(e) {
	return Number.isFinite(e) ? e + 360 * Math.round((105 - e) / 360) : NaN;
}
function be(e, t, n, r) {
	let [[i, a], [o, s]] = ve, c = k(1 - (n - r.zoom) / 2, 0, 1), l = a + Math.min(0, r.center[1] - a) * c, u = s + Math.max(0, r.center[1] - s) * c;
	return {
		center: [k(A(e), Math.min(i, r.center[0]), Math.max(o, r.center[0])), k(t, l, u)],
		zoom: k(n, Math.min(r.zoom, 18), 18)
	};
}
function xe(e, t, n, r) {
	let i = (e - n[0]) * (r[1] - n[1]) - (t - n[1]) * (r[0] - n[0]);
	return Math.abs(i) < 1e-10 && e >= Math.min(n[0], r[0]) - 1e-10 && e <= Math.max(n[0], r[0]) + 1e-10 && t >= Math.min(n[1], r[1]) - 1e-10 && t <= Math.max(n[1], r[1]) + 1e-10;
}
var j = 1e-10, Se = /* @__PURE__ */ new WeakMap(), Ce = (e, t, n) => e >= n[0] - j && e <= n[2] + j && t >= n[1] - j && t <= n[3] + j;
function we(e) {
	if (!e.length) return null;
	let t = [
		Infinity,
		Infinity,
		-Infinity,
		-Infinity
	];
	for (let [n, r] of e) t[0] = Math.min(t[0], n), t[1] = Math.min(t[1], r), t[2] = Math.max(t[2], n), t[3] = Math.max(t[3], r);
	let n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(e.length) * 2))), r = t[3] > t[1] ? n / (t[3] - t[1]) : 0, i = (e) => k(Math.floor((e - t[1]) * r), 0, n - 1), a = Array.from({ length: n }, () => []);
	for (let t = 0, n = e.length - 1; t < e.length; n = t++) {
		let r = i(Math.min(e[t][1], e[n][1]) - j), o = i(Math.max(e[t][1], e[n][1]) + j);
		for (let e = r; e <= o; e++) a[e].push(t);
	}
	return {
		points: e,
		bounds: t,
		buckets: a,
		bucket: i
	};
}
function Te(e, t, n) {
	if (!n || !Ce(e, t, n.bounds)) return !1;
	let r = !1;
	for (let i of n.buckets[n.bucket(t)]) {
		let a = n.points[i], o = n.points[i === 0 ? n.points.length - 1 : i - 1];
		if (t < Math.min(a[1], o[1]) - j || t > Math.max(a[1], o[1]) + j || e > Math.max(a[0], o[0]) + j) continue;
		let s = a[1] > t != o[1] > t;
		if (e < Math.min(a[0], o[0]) - j) {
			s && (r = !r);
			continue;
		}
		if (xe(e, t, a, o)) return !0;
		s && e < (o[0] - a[0]) * (t - a[1]) / (o[1] - a[1]) + a[0] && (r = !r);
	}
	return r;
}
function Ee(e) {
	let t = [], n = (e) => {
		if (e) {
			if (e.type === "FeatureCollection") {
				e.features.forEach(n);
				return;
			}
			if (e.type === "Feature") {
				n(e.geometry);
				return;
			}
			if (e.type === "GeometryCollection") {
				e.geometries.forEach(n);
				return;
			}
			for (let n of e.type === "Polygon" ? [e.coordinates] : e.type === "MultiPolygon" ? e.coordinates : []) {
				let e = we(n[0] || []);
				e && t.push({
					outer: e,
					holes: n.slice(1).map(we).filter(Boolean)
				});
			}
		}
	};
	if (n(e), !t.length) return {
		polygons: t,
		buckets: []
	};
	let r = Math.min(...t.map((e) => e.outer.bounds[1])), i = Math.max(...t.map((e) => e.outer.bounds[3])), a = i > r ? 256 / (i - r) : 0, o = (e) => k(Math.floor((e - r) * a), 0, 255), s = Array.from({ length: 256 }, () => []);
	for (let e of t) {
		let t = o(e.outer.bounds[1] - j), n = o(e.outer.bounds[3] + j);
		for (let r = t; r <= n; r++) s[r].push(e);
	}
	return {
		south: r,
		north: i,
		bucket: o,
		buckets: s
	};
}
function M(e, t, n) {
	let r = A(e);
	if (!Number.isFinite(r) || !Number.isFinite(t) || !n || typeof n != "object") return !1;
	let i = Se.get(n);
	return i || (i = Ee(n), Se.set(n, i)), !i.buckets.length || t < i.south - j || t > i.north + j ? !1 : i.buckets[i.bucket(t)].some((e) => Te(r, t, e.outer) && !e.holes.some((e) => Te(r, t, e)));
}
var N = Object.freeze({
	manifestBytes: 512 * 1024,
	baseBytes: 8 * 1024 * 1024,
	cellBytes: 3 * 1024 * 1024,
	viewBytes: 24 * 1024 * 1024,
	cacheBytes: 24 * 1024 * 1024,
	concurrent: 3,
	cells: 192
}), De = /* @__PURE__ */ new Set([
	"area",
	"mask",
	"territory",
	"territory-boundary"
]), Oe = {
	Point: 0,
	MultiPoint: 1,
	LineString: 1,
	MultiLineString: 2,
	Polygon: 2,
	MultiPolygon: 3
}, P = (e) => ({
	type: "FeatureCollection",
	features: e
}), F = (e) => /* @__PURE__ */ Error(`coverage-${e}`);
function ke(e) {
	if (e?.type !== "TropnikCoverage" || e.encoding !== "indexed-delta-1e7-v1" || !Array.isArray(e.positions) || e.positions.length % 2 || !Array.isArray(e.features)) throw F("encoding");
	let t = [], n = 0, r = 0;
	for (let i = 0; i < e.positions.length; i += 2) {
		let a = e.positions[i], o = e.positions[i + 1];
		if (!Number.isSafeInteger(a) || !Number.isSafeInteger(o) || (n += a, r += o, !Number.isSafeInteger(n) || !Number.isSafeInteger(r) || n < 0 || n > 36e8 || Math.abs(r) > 850511288)) throw F("coordinate");
		t.push([n / 1e7, r / 1e7]);
	}
	let i = (e, n) => {
		if (n === 0) {
			if (!Number.isSafeInteger(e) || e < 0 || e >= t.length) throw F("index");
			return t[e];
		}
		if (!Array.isArray(e) || !e.length) throw F("nesting");
		return e.map((e) => i(e, n - 1));
	}, a = e.features.map((e) => {
		if (e?.type !== "Feature" || !De.has(e.properties?.role) || typeof e.properties.cell != "string" || !(e.geometry?.type in Oe)) throw F("feature");
		return {
			...e,
			geometry: {
				type: e.geometry.type,
				coordinates: i(e.geometry.coordinates, Oe[e.geometry.type])
			}
		};
	});
	return {
		...e,
		type: "FeatureCollection",
		positions: void 0,
		features: a
	};
}
function Ae(e) {
	return e <= 4 ? "overview" : e <= 8 ? "regional" : e <= 12 ? "local" : "source";
}
function je(e, t, n) {
	let r = Ae(n);
	if (r === "overview") return [];
	let [i, a, o, s] = t;
	if (![
		i,
		a,
		o,
		s,
		n
	].every(Number.isFinite) || a > s || (o < i && (o += 360 * Math.ceil((i - o) / 360)), !Number.isFinite(o - i))) throw F("viewport");
	let c = Math.min(360, o - i), l = A(i + c / 2);
	i = l - c * .65, o = l + c * .65;
	let u = s - a;
	return a = Math.max(-85.0511288, a - u * .15), s = Math.min(85.0511288, s + u * .15), e.cells.filter((e) => e.levels[r] && [
		-360,
		0,
		360
	].some((t) => e.bounds[2] + t >= i && e.bounds[0] + t <= o && e.bounds[3] >= a && e.bounds[1] <= s));
}
function Me(e) {
	if (e?.schemaVersion !== 1 || e.encoding !== "indexed-delta-1e7-v1" || !/^[a-f0-9]{16}$/.test(e.version) || !Array.isArray(e.cells) || e.cells.length > 1024) throw F("manifest");
	let t = (e, t) => {
		if (!e || typeof e.url != "string" || !/^\/(?:[\w-]+\/)*data\/map-coverage\//.test(e.url) || e.url.includes("..") || !e.url.endsWith(".coverage") || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || e.bytes > t || !/^[a-f0-9]{64}$/.test(e.sha256)) throw F("descriptor");
	};
	t(e.base, N.baseBytes);
	let n = /* @__PURE__ */ new Set();
	for (let r of e.cells) {
		if (typeof r.id != "string" || n.has(r.id) || !Array.isArray(r.bounds) || r.bounds.length !== 4 || !r.bounds.every(Number.isFinite) || r.bounds[0] < 0 || r.bounds[2] > 360 || r.bounds[0] >= r.bounds[2] || r.bounds[1] >= r.bounds[3] || !r.levels) throw F("cell");
		n.add(r.id);
		for (let [e, n] of Object.entries(r.levels)) {
			if (![
				"regional",
				"local",
				"source"
			].includes(e)) throw F("level");
			t(n, N.cellBytes);
		}
	}
	return e;
}
async function Ne(e, t, n, r) {
	let i = await e(t, {
		signal: r,
		credentials: "same-origin"
	});
	if (!i.ok) throw F("http");
	if (Number(i.headers?.get?.("content-length")) > n) throw await i.body?.cancel(), F("size");
	if (!i.body?.getReader) {
		let e = new Uint8Array(await i.arrayBuffer());
		if (e.byteLength > n) throw F("size");
		return e;
	}
	let a = i.body.getReader(), o = [], s = 0;
	try {
		for (;;) {
			let { value: e, done: t } = await a.read();
			if (t) break;
			if (s += e.byteLength, s > n) throw await a.cancel(), F("size");
			o.push(e);
		}
	} finally {
		a.releaseLock();
	}
	let c = new Uint8Array(s), l = 0;
	for (let e of o) c.set(e, l), l += e.byteLength;
	return c;
}
async function Pe(e, t, n, r, i, a) {
	let o = await Ne(e, t.url, t.bytes, a);
	if (a?.aborted) throw new DOMException("Aborted", "AbortError");
	if (o.byteLength !== t.bytes) throw F("size");
	if ([...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", o))].map((e) => e.toString(16).padStart(2, "0")).join("") !== t.sha256) throw F("integrity");
	let s = JSON.parse(new TextDecoder().decode(o));
	if (s.coverageVersion !== n || s.lod !== r || i && s.cell !== i) throw F("identity");
	let c = ke(s);
	if (i && c.features.some((e) => e.properties.cell !== i)) throw F("identity");
	return c;
}
function Fe(e, t) {
	if (!(t.get(e.properties.cell)?.bounds[0] >= 180)) return e;
	let n = (e) => typeof e[0] == "number" ? [e[0] - 360, e[1]] : e.map(n);
	return {
		...e,
		geometry: {
			...e.geometry,
			coordinates: n(e.geometry.coordinates)
		}
	};
}
function Ie(e, t, n = {}) {
	Me(e);
	let r = n.fetch ?? globalThis.fetch.bind(globalThis), i = new Map(e.cells.map((e) => [e.id, e])), a = new Map(e.cells.map((e) => [e.id, []]));
	for (let e of t.features) {
		let t = a.get(e.properties.cell);
		if (!t) throw F("identity");
		t.push(e);
	}
	let o = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Map(), c = 0, l = 0, u, d = !1, f = "overview:", p = "overview:", m = {
		manifest: e,
		version: e.version,
		area: P([]),
		mask: P([]),
		territories: P([]),
		boundaries: P([]),
		cellFeatures: /* @__PURE__ */ new Map(),
		status: {
			version: e.version,
			lod: "overview",
			cells: [],
			pending: 0,
			error: "",
			ready: !0,
			revision: 0
		},
		subscribe(e) {
			return o.add(e), () => o.delete(e);
		},
		updateView: _,
		dispose() {
			d = !0, l++, u?.abort(), o.clear(), s.clear();
		}
	}, h = () => {
		for (let e of o) e(m);
	}, g = (e) => {
		let t = [];
		m.cellFeatures = /* @__PURE__ */ new Map();
		for (let [n, r] of a) {
			let i = e.get(n)?.features ?? r;
			m.cellFeatures.set(n, i), t.push(...i);
		}
		m.area = P(t.filter((e) => e.properties.role === "area")), m.mask = P(((e) => n.canonicalMask ? e.map((e) => Fe(e, i)) : e)(t.filter((e) => e.properties.role === "mask"))), m.territories = P(t.filter((e) => e.properties.role === "territory")), m.boundaries = P(t.filter((e) => e.properties.role === "territory-boundary"));
	};
	g(/* @__PURE__ */ new Map());
	async function _(t, n) {
		if (d) return;
		let i = Ae(n), a = je(e, t, n), o = a.map((e) => e.id).sort(), _ = `${i}:${o.join(",")}`;
		if (_ === f && (m.status.ready || m.status.pending > 0)) return;
		f = _;
		let v = ++l;
		u?.abort(), u = new AbortController();
		let y = u.signal, b = () => !d && v === l && !y.aborted;
		m.status = {
			...m.status,
			lod: i,
			cells: o,
			pending: a.length,
			error: "",
			ready: !1
		}, h();
		try {
			if (a.length > N.cells || a.reduce((e, t) => e + t.levels[i].bytes, 0) > N.viewBytes) throw F("budget");
			let t = /* @__PURE__ */ new Map(), n = 0;
			if (await Promise.all(Array.from({ length: Math.min(N.concurrent, a.length) }, async () => {
				for (; n < a.length && b();) {
					let o = a[n++], l = o.levels[i], u = `${i}:${o.id}`, d = s.get(u)?.bundle;
					if (d) {
						let e = s.get(u);
						s.delete(u), s.set(u, e);
					} else {
						if (d = await Pe(r, l, e.version, i, o.id, y), !b()) return;
						for (s.set(u, {
							bundle: d,
							bytes: l.bytes
						}), c += l.bytes; c > N.cacheBytes && s.size;) {
							let e = s.keys().next().value;
							c -= s.get(e).bytes, s.delete(e);
						}
					}
					if (!b()) return;
					t.set(o.id, d), m.status = {
						...m.status,
						pending: m.status.pending - 1
					}, h();
				}
			})), !b()) return;
			p !== _ && (g(t), m.status = {
				...m.status,
				revision: m.status.revision + 1
			}, p = _), m.status = {
				...m.status,
				pending: 0,
				ready: !0,
				error: ""
			}, h();
		} catch (e) {
			if (!b()) return;
			u.abort(), m.status = {
				...m.status,
				pending: 0,
				ready: !1,
				error: e instanceof Error && e.message.startsWith("coverage-") ? e.message : "coverage-unavailable"
			}, h();
		}
	}
	return m;
}
var I = /* @__PURE__ */ new Map();
async function Le(e = {}) {
	let t = e.manifestURL ?? "/data/map-coverage/manifest.json", n = e.fetch ?? globalThis.fetch.bind(globalThis), r = !e.fetch && I.get(t);
	r || (r = (async () => {
		let e = await Ne(n, t, N.manifestBytes), r = Me(JSON.parse(new TextDecoder().decode(e)));
		return {
			manifest: r,
			base: await Pe(n, r.base, r.version, "overview")
		};
	})(), e.fetch || (I.set(t, r), r.catch(() => I.delete(t))));
	let { manifest: i, base: a } = await r;
	return Ie(i, a, e);
}
//#endregion
//#region web/lib/map-preload.ts
var Re = "20261106-3", ze = new me(), Be = () => typeof location > "u" ? "https://map-preview.local" : location.origin;
`${Re}`;
function Ve(e) {
	return he(e, Be());
}
function He(e, t = 0) {
	let n = Ve(e);
	return n ? ze.json(n, t) : Promise.reject(/* @__PURE__ */ Error("Unknown public map resource"));
}
function Ue(e, t = 1, n) {
	let r = Ve(e);
	return r ? ze.get(r, t, n) : Promise.reject(/* @__PURE__ */ Error("Unknown public map resource"));
}
//#endregion
//#region web/lib/map-satellite.ts
var We = "tropnik-satellite", Ge = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg", Ke = "tropnik-satellite-overview", qe = "https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg", Je = [
	176,
	61,
	183,
	72.5
], Ye = {
	"eox-s2": {
		source: We,
		tiles: Ge,
		maxzoom: 14,
		attribution: "EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0"
	},
	"eox-bluemarble": {
		source: Ke,
		tiles: qe,
		maxzoom: 8,
		attribution: "NASA Earth Observatory · Blue Marble · EOX::Maps"
	}
};
function Xe({ west: e, south: t, east: n, north: r }) {
	if (![
		e,
		t,
		n,
		r
	].every(Number.isFinite)) return "eox-s2";
	let [i, a, o, s] = Je;
	return r < a || t > s ? "eox-s2" : (n < e && (n += 360 * Math.ceil((e - n) / 360)), n - e >= 360 || i + Math.ceil((e - o) / 360) * 360 <= n ? "eox-bluemarble" : "eox-s2");
}
//#endregion
//#region web/lib/custom-map-tiles.worker.ts?worker&url
var Ze = "" + new URL("../workers/custom-map-tiles.worker-DIXTfJlZ.js", import.meta.url).href, Qe = 96, $e = 288, et = 160, tt = 3, nt = 6, L = 8 * 1024 * 1024, rt = (e, t) => (e % 2 ** t + 2 ** t) % 2 ** t;
function it(e) {
	let t = e.paintZoom === void 0 ? e.z : e.paintZoom;
	if (!Number.isInteger(e.z) || e.z < 0 || !Number.isInteger(t) || t < e.z || t > 18) throw Error("Invalid map paint zoom");
	return t;
}
function R(e) {
	return `${e.kind}:${e.z}/${e.x}/${e.y}:${e.paths === !1 ? 0 : 1}:${+!!e.transparent}:${it(e)}:${e.boundaries === !1 ? 0 : 1}`;
}
function at(e, t, n, r = Math.min(e, 12)) {
	let i = 2 ** (e - r), a = t - Math.floor(t / i) * i, o = n - Math.floor(n / i) * i, s = [0], c = [0];
	a === 0 && s.push(-1), a === i - 1 && s.push(1), o === 0 && c.push(-1), o === i - 1 && c.push(1);
	let l = [];
	for (let e of c) for (let t of s) (t || e) && l.push({
		dx: t,
		dy: e
	});
	return l;
}
var ot = class {
	constructor(e = !1) {
		this.softwareRaster = e, this.cache = /* @__PURE__ */ new Map(), this.jobs = /* @__PURE__ */ new Map(), this.pinned = /* @__PURE__ */ new Set(), this.fetching = 0, this.reading = /* @__PURE__ */ new Set(), this.lastHaloWork = 0, this.serial = 0, this.disposed = !1, this.enabled = !0, this.errors = [];
	}
	snapshot() {
		return {
			resident: this.cache.size,
			pending: this.jobs.size,
			fetching: this.fetching,
			decoding: !!this.active,
			enabled: this.enabled,
			stages: [...this.jobs.values()].reduce((e, { work: t }) => (e[t.stage] = (e[t.stage] || 0) + 1, e), {}),
			errors: this.errors.map((e) => ({ ...e }))
		};
	}
	get pending() {
		return this.jobs.size;
	}
	get resident() {
		return this.cache.size;
	}
	setActive(e) {
		this.enabled = e, e && this.pump();
	}
	pin(e) {
		this.pinned = new Set(e);
		for (let [e, { work: t }] of this.jobs) !this.pinned.has(e) && t.stage !== "decoding" && (this.jobs.delete(e), t.controller.abort(), t.bytes = void 0, t.halo = void 0, t.haloPlan = void 0, t.reject(/* @__PURE__ */ Error("Map view changed")));
		this.evict(!0);
	}
	peek(e) {
		return this.cache.get(e);
	}
	load(e) {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ Error("Map resources released"));
		let t;
		try {
			t = R(e);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : /* @__PURE__ */ Error("Invalid map tile request"));
		}
		let n = this.cache.get(t), r = this.jobs.get(t);
		if (n) return this.cache.delete(t), this.cache.set(t, n), Promise.resolve(n);
		if (r) return r.promise;
		if (this.jobs.size >= et) return Promise.reject(/* @__PURE__ */ Error("Map tile queue is full"));
		let i, a, o = new Promise((e, t) => {
			i = e, a = t;
		}), s = {
			id: ++this.serial,
			request: e,
			key: t,
			resolve: i,
			reject: a,
			controller: new AbortController(),
			stage: "queued"
		};
		return this.jobs.set(t, {
			work: s,
			promise: o
		}), this.pump(), o;
	}
	files() {
		return this.localFiles ??= He("/offline-map/manifest.json").then((e) => new Set(e.files.map((e) => e.path))).catch(() => (this.localFiles = void 0, /* @__PURE__ */ new Set()));
	}
	async source(e) {
		let { kind: t } = e.request, n = Math.min(e.request.z, t === "vector" ? 14 : t === "relief" ? 12 : e.request.z), r = 2 ** (e.request.z - n), i = Math.floor(e.request.x / r), a = Math.floor(e.request.y / r), o = rt(i, n);
		if (e.sourceZ = n, t === "overview") return {
			url: `/maps/russia-relief/${n}/${o}/${a}.png`,
			local: !0,
			mime: "image/png"
		};
		if (t === "eox-s2" || t === "eox-bluemarble") return {
			url: Ye[t].tiles.replace("{z}", String(n)).replace("{x}", String(o)).replace("{y}", String(a)),
			local: !1,
			mime: "image/jpeg"
		};
		let s = t === "vector" ? `localtiles/${n}/${o}/${a}.pbf` : `terrain/tiles/${n}/${o}/${a}.png`;
		if ((await this.files()).has(s)) return {
			url: `/offline-map/${s}`,
			local: !0,
			mime: t === "vector" ? "application/x-protobuf" : "image/png"
		};
		if (!navigator.onLine) throw Error("This tile is not in the saved package");
		return t === "relief" ? {
			url: `https://tiles.mapterhorn.com/${n}/${o}/${a}.webp`,
			local: !1,
			mime: "image/webp"
		} : {
			url: (await (this.template ??= He("https://tiles.openfreemap.org/planet/latest").then((e) => {
				let t = e.tiles?.[0];
				if (!t?.startsWith("https://tiles.openfreemap.org/")) throw Error("Unrecognized vector source");
				return t;
			}).catch((e) => {
				throw this.template = void 0, e;
			}))).replace("{z}", String(n)).replace("{x}", String(o)).replace("{y}", String(a)),
			local: !1,
			mime: "application/x-protobuf"
		};
	}
	current(e) {
		return !this.disposed && this.jobs.get(e.key)?.work === e;
	}
	async readSource(e, t, n) {
		this.reading.add(t);
		try {
			return await Ue(t, n, e.controller.signal);
		} finally {
			this.reading.delete(t);
		}
	}
	async fetchPrimary(e) {
		let t = e.source ?? await this.source(e);
		if (!this.current(e)) return;
		if (e.source = t, this.reading.has(t.url)) {
			e.stage = "queued";
			return;
		}
		e.local = t.local, e.mime = t.mime, e.sourceKey = t.url;
		let n = await this.readSource(e, t.url, 0);
		if (this.current(e)) {
			if (n.byteLength > L) throw Error("Map source exceeds tile budget");
			if (!n.byteLength && e.request.kind !== "vector") throw Error("Empty raster map source");
			if (e.bytes = n.slice(0), e.request.kind === "relief") {
				let { z: r, x: i, y: a } = e.request, o = e.sourceZ, s = 2 ** (r - o), c = Math.floor(i / s), l = Math.floor(a / s), u = e.local ? await this.files() : void 0;
				if (!this.current(e)) return;
				e.halo = {
					tiles: [],
					missing: []
				}, e.haloPlan = {
					offsets: at(r, i, a, o),
					index: 0,
					sourceZ: o,
					parentX: c,
					parentY: l,
					files: u,
					copies: /* @__PURE__ */ new Map([[t.url, e.bytes]]),
					bytes: n.byteLength
				}, e.stage = e.haloPlan.offsets.length ? "halo" : "ready";
			} else e.stage = "ready";
		}
	}
	haloDependency(e, t) {
		let n = e.haloPlan, r = rt(n.parentX + t.dx, n.sourceZ), i = n.parentY + t.dy;
		if (i < 0 || i >= 2 ** n.sourceZ) return { reason: "coverage" };
		let a = `terrain/tiles/${n.sourceZ}/${r}/${i}.png`, o = !!e.local && !!n.files?.has(a);
		if (!o && !navigator.onLine) return { reason: "unavailable" };
		let s = o ? `/offline-map/${a}` : `https://tiles.mapterhorn.com/${n.sourceZ}/${r}/${i}.webp`;
		return { item: {
			...t,
			sourceKey: s,
			mime: o ? "image/png" : "image/webp",
			...!o && e.local ? { reduceToArchive: !0 } : {}
		} };
	}
	async fetchHalo(e) {
		let t = e.haloPlan, n = e.halo;
		for (; t.index < t.offsets.length;) {
			if (!this.current(e)) return;
			let r = t.offsets[t.index], i = this.haloDependency(e, r);
			if ("reason" in i) {
				n.missing.push({
					...r,
					reason: i.reason
				}), t.index++;
				continue;
			}
			let { item: a } = i, o = t.copies.get(a.sourceKey);
			if (o) {
				n.tiles.push({
					...a,
					bytes: o
				}), t.index++;
				continue;
			}
			if (t.bytes >= L) {
				n.missing.push({
					...r,
					reason: "budget"
				}), t.index++;
				continue;
			}
			if (this.reading.has(a.sourceKey)) {
				e.stage = "halo";
				return;
			}
			try {
				let i = await this.readSource(e, a.sourceKey, 1);
				if (!this.current(e)) return;
				if (!i.byteLength) n.missing.push({
					...r,
					reason: "invalid"
				});
				else if (t.bytes + i.byteLength > L) n.missing.push({
					...r,
					reason: "budget"
				});
				else {
					let e = i.slice(0);
					t.copies.set(a.sourceKey, e), t.bytes += e.byteLength, n.tiles.push({
						...a,
						bytes: e
					});
				}
			} catch {
				if (!this.current(e)) return;
				n.missing.push({
					...r,
					reason: "unavailable"
				});
			}
			t.index++, e.stage = t.index < t.offsets.length ? "halo" : "ready";
			return;
		}
		this.current(e) && (e.stage = "ready");
	}
	finish(e, t, n) {
		if (e.bytes = void 0, e.halo = void 0, e.haloPlan = void 0, this.jobs.get(e.key)?.work !== e) {
			t?.bitmap.close();
			return;
		}
		if (this.jobs.delete(e.key), t && !this.disposed && this.cache.size < $e) this.cache.set(e.key, t), e.resolve(t), this.evict();
		else {
			t?.bitmap.close();
			let r = n || /* @__PURE__ */ Error("Map tile unavailable");
			this.errors.push({
				key: e.key,
				message: r.message
			}), this.errors.length > 6 && this.errors.shift(), e.reject(r);
		}
		this.pump();
	}
	evict(e = !1) {
		for (let [t, n] of this.cache) this.pinned.has(t) || this.cache.size <= Qe && !(e && n.reliefCoverage?.missing.some((e) => e.reason !== "coverage")) || (this.cache.delete(t), n.bitmap.close());
	}
	decode(e) {
		try {
			if (!this.worker) {
				let e = new Worker(new URL(Ze, location.href), {
					type: "module",
					name: "tropnik-cartography"
				});
				this.worker = e, e.onmessage = (e) => {
					let t = this.active;
					if (!t || e.data.id !== t.id || this.disposed) {
						e.data.bitmap?.close();
						return;
					}
					clearTimeout(this.timer), this.active = void 0, e.data.bitmap ? this.finish(t, {
						key: t.key,
						...t.request,
						bitmap: e.data.bitmap,
						labels: e.data.labels || [],
						contours: e.data.contours || 0,
						local: !!t.local,
						...e.data.reliefCoverage ? { reliefCoverage: e.data.reliefCoverage } : {}
					}) : this.finish(t, void 0, Error(e.data.error || "Tile decoding failed"));
				}, e.onerror = (e) => this.failWorker(e.message || "Map tile worker failed");
			}
			this.active = e, e.stage = "decoding";
			let t = e.bytes, n = e.halo;
			e.bytes = void 0, e.halo = void 0, e.haloPlan = void 0, this.timer = setTimeout(() => this.failWorker(), 15e3), this.worker.postMessage({
				id: e.id,
				kind: e.request.kind === "vector" ? "vector" : e.request.kind === "relief" ? "relief" : "raster",
				bytes: t,
				z: e.request.z,
				x: e.request.x,
				y: e.request.y,
				paintZoom: it(e.request),
				sourceZ: e.sourceZ,
				sourceKey: e.sourceKey,
				paths: e.request.paths !== !1,
				transparent: e.request.transparent,
				boundaries: e.request.boundaries !== !1,
				softwareRaster: this.softwareRaster,
				mime: e.mime,
				halo: n
			}, [.../* @__PURE__ */ new Set([t, ...n?.tiles.map((e) => e.bytes) ?? []])]);
		} catch (t) {
			this.active = void 0, clearTimeout(this.timer), this.finish(e, void 0, t instanceof Error ? t : /* @__PURE__ */ Error("Map worker unavailable"));
		}
	}
	failWorker(e = "Map tile worker failed") {
		let t = this.active;
		this.active = void 0, clearTimeout(this.timer), this.worker?.terminate(), this.worker = void 0, t && this.finish(t, void 0, Error(e));
	}
	next(e, t) {
		let n = [
			"overview",
			"vector",
			"relief",
			"eox-s2",
			"eox-bluemarble"
		], r = t === void 0 ? -1 : n.indexOf(t);
		for (let t = 1; t <= n.length; t++) {
			let i = n[(r + t) % n.length];
			for (let { work: t } of this.jobs.values()) if (t.stage === e && t.request.kind === i && !(e === "queued" && t.source && this.reading.has(t.source.url))) return t;
		}
	}
	nextHalo() {
		let e, t;
		for (let { work: n } of this.jobs.values()) {
			if (n.stage !== "halo") continue;
			let r = n.haloPlan, i = r.offsets[r.index], a = i ? this.haloDependency(n, i) : void 0;
			a && "item" in a && !r.copies.has(a.item.sourceKey) && r.bytes < L && this.reading.has(a.item.sourceKey) || ((!e || n.id < e.id) && (e = n), n.id > this.lastHaloWork && (!t || n.id < t.id) && (t = n));
		}
		return t ?? e;
	}
	pump() {
		if (!(this.disposed || !this.enabled)) {
			if (!this.active) {
				let e = this.next("ready", this.lastDecodeKind);
				e && (this.lastDecodeKind = e.request.kind, this.decode(e));
			}
			for (; this.fetching < tt;) {
				let e = ([...this.jobs.values()].filter(({ work: e }) => e.stage === "fetching" || e.stage === "halo" || e.stage === "ready").length < nt ? this.next("queued", this.lastFetchKind) : void 0) ?? this.nextHalo();
				if (!e) break;
				let t = e.stage === "halo";
				t && (this.lastHaloWork = e.id), this.lastFetchKind = e.request.kind, e.stage = "fetching", this.fetching++, (t ? this.fetchHalo(e) : this.fetchPrimary(e)).catch((t) => this.finish(e, void 0, t instanceof Error ? t : /* @__PURE__ */ Error("Tile download failed"))).finally(() => {
					this.fetching--, this.pump();
				});
			}
		}
	}
	destroy() {
		if (!this.disposed) {
			this.disposed = !0, clearTimeout(this.timer), this.worker?.terminate(), this.worker = void 0;
			for (let { work: e } of this.jobs.values()) e.controller.abort(), e.bytes = void 0, e.halo = void 0, e.haloPlan = void 0, e.reject(/* @__PURE__ */ Error("Map resources released"));
			this.jobs.clear();
			for (let e of this.cache.values()) e.bitmap.close();
			this.cache.clear(), this.pinned.clear(), this.active = void 0;
		}
	}
};
//#endregion
//#region web/lib/russia-map.ts
async function st(e = !1) {
	return Le({ canonicalMask: e });
}
//#endregion
//#region web/lib/map-framing.ts
function z(e, t, n, r, i) {
	let a = be(e, t, n, r);
	if (!i || ![...i.center, i.zoom].every(Number.isFinite)) return a;
	let o = Math.max(0, Math.min(1, 1 - (n - i.zoom) / 2));
	if (!o) return a;
	let s = be(...i.center, n, r), c = i.center.map((e, t) => s.center[t] + (e - s.center[t]) * o), l = [A(e), t];
	return {
		...a,
		center: a.center.map((e, t) => Math.max(Math.min(e, c[t]), Math.min(Math.max(e, c[t]), l[t])))
	};
}
Object.freeze({
	ink: "#244D3C",
	paper: "#FFFEFA",
	accent: "#A56736",
	closeZoom: 10
});
function B(e) {
	return 3 + Math.max(0, Math.min(1, ((Number.isFinite(e) ? e : 10) - 8) / 6)) * 2;
}
var V = Object.freeze({
	badgeSize: 32,
	labelWidth: 64,
	labelHeight: 24,
	labelGap: 4,
	clearance: 8
});
function ct(e, t) {
	if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return "hidden";
	if (!t) return "full";
	if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return "hidden";
	let n = Math.abs(e.x - t.x), r = Math.abs(e.y - t.y), i = V.badgeSize + V.clearance;
	if (n < i && r < i) return "hidden";
	let a = V.badgeSize + V.labelGap + V.labelHeight;
	return n < V.labelWidth + V.clearance && r < a + V.clearance ? "compact" : "full";
}
function lt(e) {
	let t = e[0], n = e[1];
	if (!t) return;
	let r = ct(t.project(), n?.project());
	t.element.dataset.routeEdgeDensity !== r && (t.element.dataset.routeEdgeDensity = r), n && n.element.dataset.routeEdgeDensity !== r && (n.element.dataset.routeEdgeDensity = r);
}
function ut(e) {
	let t, n = 0, r = (e) => {
		e.length < 2 || (n++, n === 1 && (t = e));
	}, i = (e) => {
		if (!(!e || n > 1)) {
			if (e.type === "FeatureCollection") for (let t of e.features) i(t);
			else if (e.type === "Feature") i(e.geometry);
			else if (e.type === "GeometryCollection") for (let t of e.geometries) i(t);
			else if (e.type === "LineString") r(e.coordinates);
			else if (e.type === "MultiLineString") {
				for (let t of e.coordinates) if (r(t), n > 1) break;
			}
		}
	};
	if (i(e), n !== 1 || !t) return [];
	let a = t[0], o = t[t.length - 1], s = (e, t) => Math.abs(e[1] - t[1]) < 1e-9 && Math.abs(((e[0] - t[0]) % 360 + 540) % 360 - 180) < 1e-9;
	if (!t.some((e) => !s(a, e))) return [];
	let c = [a[0], a[1]];
	return s(a, o) ? [{
		coordinate: c,
		kind: "shared",
		label: "Совпадающие края исходной линии"
	}] : [{
		coordinate: c,
		kind: "first",
		label: "Край А исходной линии"
	}, {
		coordinate: [o[0], o[1]],
		kind: "last",
		label: "Край Б исходной линии"
	}];
}
function dt(e) {
	let t = document.createElement("div");
	t.className = `route-edge-marker route-edge-marker--${e.kind}`, t.dataset.routeEdgeDensity = "hidden", t.style.setProperty("--route-edge-badge-size", `${V.badgeSize}px`), t.style.setProperty("--route-edge-label-width", `${V.labelWidth}px`), t.style.setProperty("--route-edge-label-height", `${V.labelHeight}px`), t.style.setProperty("--route-edge-label-gap", `${V.labelGap}px`), t.setAttribute("role", "img"), t.setAttribute("aria-label", e.label);
	let n = document.createElement("span");
	n.className = "route-edge-badge", n.textContent = e.kind === "last" ? "Б" : "А", n.setAttribute("aria-hidden", "true");
	let r = document.createElement("span");
	return r.className = "route-edge-label", r.textContent = e.kind === "shared" ? "А · Б" : e.kind === "last" ? "Точка Б" : "Точка А", r.setAttribute("aria-hidden", "true"), t.appendChild(n), t.appendChild(r), t;
}
//#endregion
//#region web/lib/map-interaction.ts
function ft(e, t) {
	!e || ![
		t.longitude,
		t.latitude,
		t.zoom
	].every(Number.isFinite) || (e.dataset.mapEngine = t.engine, e.dataset.mapLongitude = String(t.longitude), e.dataset.mapLatitude = String(t.latitude), e.dataset.mapZoom = String(t.zoom), e.dataset.mapTileSize = String(t.tileSize), Number.isFinite(t.centerX) && Number.isFinite(t.centerY) ? (e.dataset.mapCenterX = String(t.centerX), e.dataset.mapCenterY = String(t.centerY)) : (delete e.dataset.mapCenterX, delete e.dataset.mapCenterY));
}
//#endregion
//#region web/lib/map-direction-marker.ts
function pt(e, t = document) {
	let n = t.createElement("button");
	n.type = "button", n.className = `region-marker region-marker-${e.id}`, n.dataset.regionId = e.id, n.setAttribute("aria-label", `Открыть ${e.name}`);
	let r = t.createElement("span");
	r.className = "region-marker-emblem", r.setAttribute("aria-hidden", "true");
	let i = "http://www.w3.org/2000/svg", a = t.createElementNS(i, "svg");
	a.setAttribute("viewBox", "0 0 24 28"), a.setAttribute("width", "24"), a.setAttribute("height", "28"), a.setAttribute("focusable", "false"), a.setAttribute("aria-hidden", "true");
	let o = t.createElementNS(i, "path");
	o.setAttribute("class", "region-marker-flag"), o.setAttribute("d", "M2 1h20v26l-10-5-10 5Z"), o.setAttribute("stroke-width", "1.5"), o.setAttribute("stroke-linejoin", "round");
	let s = t.createElementNS(i, "path");
	s.setAttribute("class", "region-marker-ridge"), s.setAttribute("d", "m5 17 5-8 3 5 2-3 4 6M8 12l2 1 2-1"), s.setAttribute("fill", "none"), s.setAttribute("stroke-width", "1.5"), s.setAttribute("stroke-linecap", "round"), s.setAttribute("stroke-linejoin", "round"), a.appendChild(o), a.appendChild(s);
	let c = t.createElement("span");
	c.className = "region-marker-count", c.setAttribute("aria-hidden", "true"), r.appendChild(a), r.appendChild(c);
	let l = t.createElement("span");
	return l.className = "region-marker-label", l.textContent = e.name, n.appendChild(r), n.appendChild(l), n;
}
var mt = 168;
function ht(e) {
	return Math.min(mt, Math.max(84, Math.ceil([...e].length * 7.1 + 24)));
}
function H(e, t, n) {
	e.style.getPropertyValue(t) !== n && e.style.setProperty(t, n);
}
var gt = {
	wide: {
		edge: 18,
		top: 18,
		right: 18,
		bottom: 18
	},
	compact: {
		edge: 12,
		top: 12,
		right: 12,
		bottom: 12
	}
}, _t = [
	".map-context",
	".map-style-switch",
	".map-controls",
	".layer-control",
	".layer-menu",
	".map-message",
	".map-preload-status",
	".map-legend",
	".map-attribution",
	".map-attribution-content",
	".fact-card",
	".fact-closed",
	".explore-panel"
];
function vt(e, t, n) {
	let r = t ? gt.compact : gt.wide, i = e.left + r.edge, a = e.right - r.right, o = e.top + r.top, s = Math.min(e.bottom - r.bottom, n ?? Infinity);
	return a - i < 160 && (a = e.right - r.edge), s - o < 96 && (o = e.top + r.edge, s = Math.min(e.bottom - r.edge, n ?? Infinity)), a = Math.max(i + 1, a), s = Math.max(o + 1, s), {
		left: i,
		right: a,
		top: o,
		bottom: s
	};
}
function yt(e, t) {
	if (![...Object.values(e), ...Object.values(t)].every(Number.isFinite) || e.right < e.left || e.bottom < e.top) return {
		x: 0,
		y: 0
	};
	let n = e.right - e.left, r = e.bottom - e.top, i = t.right - t.left, a = t.bottom - t.top, o = 0, s = 0;
	return n >= i || e.left < t.left ? o = t.left - e.left : e.right > t.right && (o = t.right - e.right), r >= a || e.top < t.top ? s = t.top - e.top : e.bottom > t.bottom && (s = t.bottom - e.bottom), {
		x: o,
		y: s
	};
}
var U = (e, t, n) => ({
	left: e.left + t,
	right: e.right + t,
	top: e.top + n,
	bottom: e.bottom + n
}), bt = (e, t) => e.left >= t.left - .5 && e.right <= t.right + .5 && e.top >= t.top - .5 && e.bottom <= t.bottom + .5, W = (e, t, n = 0) => e.left < t.right + n && e.right > t.left - n && e.top < t.bottom + n && e.bottom > t.top - n;
function xt(e, t, n, r = 8) {
	let i = yt(e, t), a = i.x, o = i.y, s = U(e, a, o), c = n.filter((e) => [...Object.values(e)].every(Number.isFinite) && e.right > e.left && e.bottom > e.top);
	for (let e = 0; e < Math.min(16, c.length + 4); e++) {
		let e = c.find((e) => W(s, e, r));
		if (!e) return {
			x: a,
			y: o,
			hidden: Math.hypot(a, o) > 180
		};
		let n = [
			{
				dx: e.left - r - s.right,
				dy: 0
			},
			{
				dx: e.right + r - s.left,
				dy: 0
			},
			{
				dx: 0,
				dy: e.top - r - s.bottom
			},
			{
				dx: 0,
				dy: e.bottom + r - s.top
			}
		].map((e) => ({
			...e,
			rect: U(s, e.dx, e.dy)
		})).filter((e) => bt(e.rect, t)).sort((e, t) => Math.abs(e.dx) + Math.abs(e.dy) - (Math.abs(t.dx) + Math.abs(t.dy)))[0];
		if (!n) return {
			x: a,
			y: o,
			hidden: !0
		};
		a += n.dx, o += n.dy, s = n.rect;
	}
	return {
		x: a,
		y: o,
		hidden: !0
	};
}
function St(e, t, n, r, i = 8) {
	if (![
		...Object.values(e),
		...Object.values(t),
		...Object.values(n)
	].every(Number.isFinite)) return {
		x: 0,
		y: 0,
		hidden: !0
	};
	let a = e.right - e.left, o = e.bottom - e.top;
	if (a <= 0 || o <= 0 || t.right <= t.left || t.bottom <= t.top) return {
		x: 0,
		y: 0,
		hidden: !0
	};
	let s = (t.left + t.right) / 2 - a / 2, c = r.filter((e) => Object.values(e).every(Number.isFinite) && e.right > e.left && e.bottom > e.top), l = (n) => {
		let r = s - e.left, a = (n ? t.bottom + 4 : t.top - o - 4) - e.top;
		for (let t = 0; t <= c.length; t++) {
			let t = U(e, r, a), s = c.find((e) => W(t, e, i));
			if (!s) break;
			a = (n ? s.bottom + i : s.top - i - o) - e.top;
		}
		return {
			x: r,
			y: a
		};
	}, u = [
		{
			x: 0,
			y: 0
		},
		{
			x: t.left + t.right - e.right - e.left,
			y: 0
		},
		l(!1),
		l(!0)
	].sort((e, t) => e.x * e.x + e.y * e.y - (t.x * t.x + t.y * t.y));
	for (let r of u) {
		let s = U(e, r.x, r.y);
		if (!(Math.hypot((s.left + s.right - t.left - t.right) / 2, (s.top + s.bottom - t.top - t.bottom) / 2) > 44 + Math.max(a, o) / 2) && bt(s, n) && !c.some((e) => W(s, e, i))) return {
			...r,
			hidden: !1
		};
	}
	return {
		x: 0,
		y: 0,
		hidden: !0
	};
}
function Ct(e, t, n, r, i = 8) {
	let a = t.top - r.top - i, o = r.bottom - t.bottom - i;
	return e === "top" ? a >= n || a >= o ? "top" : "bottom" : o >= n || o >= a ? "bottom" : "top";
}
function wt(e, t) {
	let n = getComputedStyle(e);
	if (n.display === "none" || n.visibility === "hidden" || Number(n.opacity) === 0) return;
	let r = e.getBoundingClientRect();
	if (!(r.width < 2 || r.height < 2 || !W(r, t))) return {
		left: r.left,
		right: r.right,
		top: r.top,
		bottom: r.bottom
	};
}
function Tt(e, t) {
	return [...(e.closest(".explore-layout") ?? e.parentElement ?? e).querySelectorAll(_t.join(","))].filter((t) => t !== e && !t.contains(e)).map((e) => wt(e, t)).filter((e) => !!e);
}
function Et(e) {
	if (typeof window > "u" || !window.visualViewport) return e;
	let t = window.visualViewport, n = {
		left: Math.max(e.left, t.offsetLeft),
		right: Math.min(e.right, t.offsetLeft + t.width),
		top: Math.max(e.top, t.offsetTop),
		bottom: Math.min(e.bottom, t.offsetTop + t.height)
	};
	return n.right - n.left >= 80 && n.bottom - n.top >= 80 ? n : e;
}
function Dt(e) {
	let t = Et(e.getBoundingClientRect()), n = (e.closest(".explore-layout") ?? e.parentElement ?? e).querySelector(".explore-panel"), r;
	if (n) {
		let e = n.getBoundingClientRect();
		e.left < t.right && e.right > t.left && e.top > t.top && e.top < t.bottom && (r = Math.max(t.top + 72, e.top - 12));
	}
	let i = Math.min(e.clientWidth, t.right - t.left) <= 700;
	return {
		safe: vt(t, i, r),
		obstacles: Tt(e, t),
		compact: i
	};
}
function Ot(e, t) {
	let { safe: n, obstacles: r } = Dt(t), i = [], a = [], o = [...e.values()].filter((e) => !e.hidden && e.isConnected).sort((e, t) => {
		let n = (e) => e.classList.contains("is-selected") ? 0 : e.classList.contains("direction-cluster") ? 1 : 2;
		return n(e) - n(t) || (e.dataset.regionId ?? "").localeCompare(t.dataset.regionId ?? "", "en");
	});
	for (let e of o) {
		let t = e.querySelector(".region-marker-count");
		t && (delete e.dataset.mapCountHidden, H(t, "--map-count-shift-x", "0px"), H(t, "--map-count-shift-y", "0px"), t.textContent && a.push({
			button: e,
			count: t
		}));
		let n = e.querySelector(".region-marker-label");
		n && i.push({
			button: e,
			label: n,
			preferred: "bottom",
			placement: "bottom"
		});
	}
	for (let e of t.querySelectorAll(".trail-marker")) {
		if (!e.isConnected) continue;
		let t = e.querySelector(".trail-marker-label");
		if (t) {
			if (!(e.classList.contains("is-selected") || e.matches(":hover,:focus-visible,:focus-within"))) {
				delete e.dataset.mapLabelHidden, H(t, "--map-label-shift-x", "0px"), H(t, "--map-label-shift-y", "0px");
				continue;
			}
			i.push({
				button: e,
				label: t,
				preferred: "top",
				placement: "top"
			});
		}
	}
	let s = Math.max(48, n.right - n.left - 12);
	for (let { button: e, label: t, preferred: n } of i) e.dataset.mapLabelPlacement !== n && (e.dataset.mapLabelPlacement = n), delete e.dataset.mapLabelHidden, H(t, "--map-label-max-width", `${Math.floor(Math.max(48, Math.min(n === "top" ? 230 : 168, s)))}px`), H(t, "--map-label-shift-x", "0px"), H(t, "--map-label-shift-y", "0px");
	for (let e of i) {
		let t = e.button.getBoundingClientRect(), r = e.label.getBoundingClientRect();
		r.width < 2 || r.height < 2 || (e.rect = r, e.placement = Ct(e.preferred, t, r.height, n));
	}
	for (let e of i) e.rect && e.placement !== e.preferred && (e.button.dataset.mapLabelPlacement = e.placement);
	for (let e of i) e.rect && e.placement !== e.preferred && (e.rect = e.label.getBoundingClientRect());
	for (let e of a) {
		let t = e.button.getBoundingClientRect(), n = e.count.getBoundingClientRect();
		n.width < 2 || n.height < 2 || (e.marker = t, e.rect = n);
	}
	for (let e of a) {
		if (!e.rect || !e.marker) continue;
		let t = a.filter((t) => t !== e && t.marker).map((e) => e.marker);
		e.shift = St(e.rect, e.marker, n, [...r, ...t]), e.shift.hidden || r.push(U(e.rect, e.shift.x, e.shift.y));
	}
	for (let e of i) {
		if (!e.rect) continue;
		let t = xt(e.rect, n, r);
		e.shift = {
			x: Math.round(t.x),
			y: Math.round(t.y),
			hidden: t.hidden
		}, t.hidden || r.push(U(e.rect, e.shift.x, e.shift.y));
	}
	for (let { button: e, label: t, preferred: n, placement: r, shift: a } of i) a && (H(t, "--map-label-shift-x", `${a.x}px`), H(t, "--map-label-shift-y", `${a.y}px`), a.hidden && (e.dataset.mapLabelHidden = "true"), e.classList.toggle("map-label-shifted", a.x !== 0 || a.y !== 0 || r !== n));
	for (let { button: e, count: t, shift: n } of a) n && (H(t, "--map-count-shift-x", `${n.x}px`), H(t, "--map-count-shift-y", `${n.y}px`), n.hidden && (e.dataset.mapCountHidden = "true"));
}
function kt(e) {
	let t = e % 100, n = e % 10;
	return `${e} ${t >= 11 && t <= 14 ? "направлений" : n === 1 ? "направление" : n >= 2 && n <= 4 ? "направления" : "направлений"}`;
}
function At(e, t) {
	return Math.abs(e.point.x - t.point.x) < (e.width + t.width) / 2 + 12 && Math.abs(e.point.y - t.point.y) < (e.height + t.height) / 2 + 12;
}
function jt(e, t) {
	let n = e.filter((e) => t.has(e.id)), r = n.length ? n : e, i = e.reduce((e, t) => e + t.center[1], 0) / e.length, a = Math.max(.15, Math.cos(i * Math.PI / 180)), o = (e) => e < 0 ? e + 360 : e, s = (t) => e.reduce((e, n) => {
		let r = (o(t.center[0]) - o(n.center[0])) * a, i = t.center[1] - n.center[1];
		return e + r * r + i * i;
	}, 0);
	return [...r].sort((e, t) => s(e) - s(t) || e.id.localeCompare(t.id))[0];
}
function Mt(e, t, n = /* @__PURE__ */ new Set()) {
	let r = /* @__PURE__ */ new Map(), i = [...new Map(e.map((e) => [e.id, e])).values()].sort((e, t) => e.id.localeCompare(t.id));
	for (let e of i) r.set(e.id, t(e.center));
	let a = (e) => {
		e.sort((e, t) => e.id.localeCompare(t.id));
		let t = jt(e, n), i = e.map((e) => e.center[0] < 0 ? e.center[0] + 360 : e.center[0]), a = e.map((e) => e.center[1]);
		return {
			key: e.map((e) => e.id).join("|"),
			members: e,
			anchor: t,
			point: r.get(t.id),
			bounds: [
				Math.min(...i),
				Math.min(...a),
				Math.max(...i),
				Math.max(...a)
			],
			width: e.length > 1 ? 176 : ht(t.name),
			height: e.length > 1 || t.name.length > 22 ? 88 : 72
		};
	}, o = i.filter((e) => {
		let t = r.get(e.id);
		return Number.isFinite(t.x) && Number.isFinite(t.y);
	}).map((e) => a([e]));
	for (let e = 0; e < o.length; e++) for (let t = e + 1; t < o.length; t++) if (At(o[e], o[t])) {
		o[e] = a([...o[e].members, ...o[t].members]), o.splice(t, 1), e = -1;
		break;
	}
	return o.sort((e, t) => e.key.localeCompare(t.key));
}
function Nt(e, t, n) {
	let r = e.members.length > 1;
	return {
		cluster: r,
		label: r ? kt(e.members.length) : e.anchor.name,
		count: r ? String(e.members.length) : n ? String(t) : "",
		ariaLabel: r ? `Приблизить ${kt(e.members.length)}: ${e.members.map((e) => e.name).join(", ")}` : `Открыть ${e.anchor.name}${n ? `, маршрутов в каталоге: ${t}` : ""}`
	};
}
function Pt(e, t, n, r, i) {
	let a = new Map(t.map((e) => [e.anchor.id, e])), o = [...e].find(([, e]) => e.ownerDocument.activeElement === e)?.[0];
	for (let [t, o] of e) {
		let e = a.get(t);
		if (o.hidden !== !e && (o.hidden = !e), !e) {
			o.removeAttribute("data-map-anchor-region-id"), o.removeAttribute("data-map-group-key");
			continue;
		}
		o.getAttribute("data-map-anchor-region-id") !== e.anchor.id && o.setAttribute("data-map-anchor-region-id", e.anchor.id), o.getAttribute("data-map-group-key") !== e.key && o.setAttribute("data-map-group-key", e.key);
		let s = Nt(e, n.get(t) || 0, r);
		o.classList.toggle("direction-cluster", s.cluster), o.classList.toggle("is-overview", r), o.classList.toggle("is-selected", e.members.some((e) => e.id === i));
		let c = o.querySelector(".region-marker-count"), l = o.querySelector(".region-marker-label");
		c && c.textContent !== s.count && (c.textContent = s.count), l && l.textContent !== s.label && (l.textContent = s.label), o.getAttribute("aria-label") !== s.ariaLabel && o.setAttribute("aria-label", s.ariaLabel), o.removeAttribute("title");
	}
	if (o && !a.has(o)) {
		let n = t.find((e) => e.members.some((e) => e.id === o));
		n && e.get(n.anchor.id)?.focus({ preventScroll: !0 });
	}
	return a;
}
//#endregion
//#region web/lib/custom-map-symbols.ts
var Ft = Object.freeze({
	camp: [
		"m4 23 10-18 10 18H4Z",
		"m10 23 4-8 4 8M11 2l3 3 3-3",
		"M2 25h24"
	],
	water: [
		"M14 3c-2 4-7 9-7 14a7 7 0 0 0 14 0c0-5-5-10-7-14Z",
		"M10 18c0 2 1 3 3 3",
		"M4 25h20"
	],
	shelter: [
		"m3 13 11-10 11 10M6 11v13h16V11",
		"M11 24v-8h6v8",
		"M3 26h22"
	],
	pass: [
		"m2 22 6-13 6 8 6-8 6 13",
		"M8 5v4m12-4v4",
		"m11 24 3-7 3 7"
	],
	peak: [
		"m3 24 11-20 11 20H3Z",
		"m10 11 4 3 4-3",
		"M14 4V1m7 4 2-2M7 5 5 3"
	],
	viewpoint: [
		"M3 15s4-7 11-7 11 7 11 7-4 7-11 7S3 15 3 15Z",
		"m9 17 5-8 5 8H9Z",
		"M14 3V1m-9 5L3 4m20 2 2-2"
	],
	info: [
		"M24 14A10 10 0 1 1 4 14a10 10 0 0 1 20 0Z",
		"M13 12h2v8m-2 0h4",
		"M14 8v.01"
	],
	waterfall: ["M3 6h8v13m5-13v16m5-16v10", "M8 4h15M3 24c3-3 5 3 8 0s5 3 8 0 4 0 6 0"],
	landmark: [
		"M5 24h18M7 24V10h14v14M10 24v-6h8v6",
		"M5 10V5h4v3h3V3h4v5h3V5h4v5",
		"M11 12v2m6-2v2"
	]
}), It = /* @__PURE__ */ new Map();
function Lt(e, t, n, r) {
	let i = It.get(t);
	i || (i = Ft[t].map((e) => new Path2D(e)), It.set(t, i));
	let a = t === "water" || t === "waterfall";
	e.save(), e.translate(n, r), e.beginPath(), e.roundRect(-12, -12, 24, 24, 8), e.fillStyle = a ? "rgba(243,250,250,.97)" : "rgba(255,254,247,.97)", e.fill(), e.lineWidth = 1, e.strokeStyle = a ? "rgba(66,124,136,.32)" : "rgba(49,83,66,.28)", e.stroke(), e.scale(18 / 28, 18 / 28), e.translate(-14, -14), e.lineWidth = 1.8, e.strokeStyle = a ? "#376e7a" : t === "landmark" ? "#886942" : "#315342", e.lineCap = "round", e.lineJoin = "round";
	for (let t of i) e.stroke(t);
	e.restore();
}
function Rt(e) {
	return e <= 3 ? 13 : e < 6 ? 13 + (e - 3) * 4 / 3 : e < 10 ? 17 + (e - 6) * 3 / 4 : 20;
}
//#endregion
//#region web/lib/custom-map-labels.ts
function zt(e, t, n) {
	let r = e.kind === "place" && (!e.placeClass || [
		"city",
		"town",
		"village"
	].includes(e.placeClass)), i = e.priorityCity ? Rt(t) : r && e.rank < 3 ? 14 : 12, a = [
		12,
		14,
		16,
		18,
		20
	].filter((e) => e <= i).at(-1) ?? 12, o = e.kind === "water" || e.symbol === "water" || e.symbol === "waterfall", s = e.kind === "contour";
	return {
		fontSize: a,
		lineHeight: a <= 12 ? 16 : a <= 14 ? 20 : a <= 16 ? 24 : 28,
		weight: r || e.kind === "peak" ? 600 : 500,
		ink: n && /^#[\da-f]{6}$/i.test(n) ? n : o ? "#315f69" : s ? "#77684e" : e.kind === "path" ? "#805536" : "#294535",
		surface: s ? "rgba(249,247,231,.91)" : o ? "rgba(244,250,249,.95)" : "rgba(255,254,247,.95)",
		border: s ? "transparent" : o ? "rgba(66,124,136,.22)" : "rgba(69,94,72,.20)",
		paddingX: s ? 4 : 8,
		paddingY: s ? 0 : 4
	};
}
function Bt(e) {
	return e.rank <= 0 ? 0 : e.priorityCity ? 1 : e.kind === "place" && ([
		"country",
		"state",
		"city",
		"town"
	].includes(e.placeClass ?? "") || !e.placeClass && e.rank < 3) ? 2 : e.symbol === "water" || e.symbol === "pass" ? 3 : e.kind === "peak" ? 4 : e.kind === "path" ? 5 : e.kind === "water" ? 6 : e.symbol === "shelter" || e.symbol === "camp" || e.symbol === "waterfall" ? 7 : e.symbol || e.kind === "place" && [
		"village",
		"hamlet",
		"isolated_dwelling"
	].includes(e.placeClass ?? "") ? 8 : e.kind === "contour" ? 9 : 10;
}
function Vt(e, t) {
	return Math.max(8, Math.min(56, Math.floor(Math.max(0, e) * Math.max(0, t) / 18e3)));
}
function Ht(e) {
	return e.kind === "path" ? 320 : e.kind === "water" || e.kind === "contour" ? 240 : 0;
}
function Ut(e) {
	return `${e.kind}:${e.text.trim().replace(/[«»„“”"]/g, "").replace(/\s+/g, " ").toLocaleLowerCase("ru")}`;
}
function Wt(e, t, n, r, i) {
	let a = t.y + (e.symbol ? 24 : 0), o = i.lineHeight / 2 + i.paddingY, s = r ? {
		left: t.x - n / 2 - i.paddingX,
		right: t.x + n / 2 + i.paddingX,
		top: a - o,
		bottom: a + o
	} : null;
	return {
		rect: {
			left: Math.min(s?.left ?? t.x, e.symbol ? t.x - 12 : t.x) - 4,
			right: Math.max(s?.right ?? t.x, e.symbol ? t.x + 12 : t.x) + 4,
			top: Math.min(s?.top ?? t.y, e.symbol ? t.y - 12 : t.y) - 4,
			bottom: Math.max(s?.bottom ?? t.y, e.symbol ? t.y + 12 : t.y) + 4
		},
		plate: s,
		textY: a,
		textWidth: n
	};
}
function Gt(e, t, n, r, i) {
	if (!t || !r.plate) return;
	let a = r.plate;
	e.beginPath(), e.roundRect(a.left, a.top, a.right - a.left, a.bottom - a.top, 4), e.fillStyle = i.surface, e.fill(), i.border !== "transparent" && (e.strokeStyle = i.border, e.lineWidth = 1, e.stroke()), e.textAlign = "center", e.textBaseline = "middle", e.fillStyle = i.ink, e.fillText(t, n.x, r.textY);
}
//#endregion
//#region web/lib/map-canvas-policy.ts
var Kt = /* @__PURE__ */ new WeakMap(), qt = /swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render|\bwarp\b/i;
function Jt(e = document) {
	let t = Kt.get(e);
	if (t) return t;
	let n = null, r = "unavailable";
	try {
		let t = e.createElement("canvas");
		if (t.width = 1, t.height = 1, n = t.getContext("webgl2", {
			alpha: !1,
			antialias: !1,
			depth: !1,
			stencil: !1,
			preserveDrawingBuffer: !1,
			failIfMajorPerformanceCaveat: !0,
			powerPreference: "default"
		}), n) {
			r = "available";
			try {
				let e = n.getExtension("WEBGL_debug_renderer_info");
				e && qt.test(String(n.getParameter(e.UNMASKED_RENDERER_WEBGL))) && (r = "software");
			} catch {}
		}
	} catch {} finally {
		try {
			n?.getExtension("WEBGL_lose_context")?.loseContext();
		} catch {}
	}
	let i = Object.freeze({
		softwareRaster: r !== "available",
		reason: r
	});
	return Kt.set(e, i), i;
}
var Yt = "tropnik-map-label-inspection";
function Xt(e) {
	if (!e || typeof e != "object") return null;
	let t = e, n = t.limit;
	return t.schemaVersion !== 1 || !Array.isArray(t.names) || t.names.length < 1 || t.names.length > 100 || !t.names.every((e) => typeof e == "string" && e.length > 0 && e.length <= 160) || new Set(t.names).size !== t.names.length || typeof n != "number" || !Number.isInteger(n) || n < 1 || n > 100 ? null : {
		schemaVersion: 1,
		names: [...t.names],
		limit: n
	};
}
function Zt(e) {
	return {
		...e,
		coordinate: [...e.coordinate],
		...e.rect ? { rect: { ...e.rect } } : {}
	};
}
function Qt(e, t, n) {
	let r = Xt(n);
	if (!r || !Number.isSafeInteger(t) || t < e.length || e.length > 6400) return null;
	let i = new Set(r.names), a = e.filter((e) => i.has(e.label));
	return {
		schemaVersion: 1,
		names: r.names,
		limit: r.limit,
		totalCandidates: t,
		retainedCandidates: e.length,
		matchingCandidates: a.length,
		truncated: t > e.length || a.length > r.limit,
		candidates: a.slice(0, r.limit).map(Zt)
	};
}
//#endregion
//#region web/lib/reviewed-coastal-routes.ts
var $t = Object.freeze([Object.freeze({
	key: "routes/kolyma-black-creek.geojson",
	sourceUrl: "https://greatkolymatrail.ru/upload/iblock/bc2/7jp03f3v0yqp8z36gjiz4o3ahdhkyxu2/1601848705912.gpx",
	descriptionUrl: "https://greatkolymatrail.ru/routes/chernyy-klyuch/",
	rawGpxSha256: "5acdd2bd5a08d5f13f680f5d398d24f2822d3c3fe15bbcce10f2acce5f209cda",
	sourceSha256: "de9dcb7a128b037e8000558efc83c926ac3e581473b62e41fdb725c73dddc46b",
	coordinateSha256: "378fd342c7fe68801764c6edb440d8e355730c6271409ab74d164577a4b402d3",
	reviewedAt: "2026-11-13",
	measuredMaximumShorelineDisagreementM: 32.22,
	originalParts: 1,
	originalPoints: 788
})]), en = "/data/";
function tn(e, t) {
	return $t.find((n) => n.key === e && (t === void 0 || t === n.sourceSha256));
}
var nn = /* @__PURE__ */ new WeakSet();
function G(e, t) {
	return !!e && nn.has(e) && (t === void 0 || e.sourceGeometry === t);
}
async function rn(e, t) {
	let n = $t.find((t) => e === en + t.key);
	if (!n || !globalThis.crypto?.subtle) return;
	let r = [], i = !0, a = (e) => {
		e && (e.type === "FeatureCollection" ? e.features.forEach(a) : e.type === "Feature" ? a(e.geometry) : e.type === "GeometryCollection" ? e.geometries.forEach(a) : e.type === "LineString" ? r.push(e.coordinates.map((e) => [...e])) : e.type === "MultiLineString" ? e.coordinates.forEach((e) => r.push(e.map((e) => [...e]))) : i = !1);
	};
	try {
		a(O(t));
	} catch {
		return;
	}
	if (!i || r.length !== n.originalParts || r.reduce((e, t) => e + t.length, 0) !== n.originalPoints) return;
	let o = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(r))))].map((e) => e.toString(16).padStart(2, "0")).join("");
	if (o !== n.coordinateSha256) return;
	let s = [
		Infinity,
		Infinity,
		-Infinity,
		-Infinity
	];
	for (let e of r) {
		let t = 105;
		for (let n of e) {
			let e = n[0] + 360 * Math.round((t - n[0]) / 360);
			t = e, s[0] = Math.min(s[0], e), s[1] = Math.min(s[1], n[1]), s[2] = Math.max(s[2], e), s[3] = Math.max(s[3], n[1]);
		}
	}
	Object.freeze(s);
	for (let e of r) {
		for (let t of e) Object.freeze(t);
		Object.freeze(e);
	}
	Object.freeze(r);
	let c = Object.freeze({
		type: "MultiLineString",
		coordinates: r
	}), l = Object.freeze({
		key: n.key,
		sourceGeometry: t,
		geometry: c,
		bounds: s,
		coordinateSha256: o
	});
	return nn.add(l), l;
}
//#endregion
//#region web/lib/map-trail-overlay.ts
var K = [8, 12], an = 1e7, on = "/data/", sn = 18e4, cn = 64, ln = 2, un = 5, dn = 256;
function q(e) {
	let t = [], n = (e) => {
		if (e.length < 2) return;
		let n = [
			Infinity,
			Infinity,
			-Infinity,
			-Infinity
		], r = 105;
		for (let t of e) {
			if (!Number.isFinite(t[0]) || !Number.isFinite(t[1]) || Math.abs(t[1]) > 85.05112878) throw Error("Invalid trail overlay coordinate");
			let e = t[0] + 360 * Math.round((r - t[0]) / 360);
			r = e, n[0] = Math.min(n[0], e), n[1] = Math.min(n[1], t[1]), n[2] = Math.max(n[2], e), n[3] = Math.max(n[3], t[1]);
		}
		t.push({
			coordinates: e,
			bounds: n
		});
	}, r = (e) => {
		e && (e.type === "FeatureCollection" ? e.features.forEach(r) : e.type === "Feature" ? r(e.geometry) : e.type === "GeometryCollection" ? e.geometries.forEach(r) : e.type === "LineString" ? n(e.coordinates) : e.type === "MultiLineString" && e.coordinates.forEach(n));
	};
	return r(e), t;
}
function* J(e, t) {
	let n = [0, 0], r = 0, i = 0;
	for (; r < e.length;) {
		for (let t = 0; t < 2; t++) {
			let i = 0, a = 1, o = !1;
			for (let t = 0; t < 8 && r < e.length; t++) {
				let t = e.charCodeAt(r++) - 63;
				if (t < 0 || t > 63) throw Error("Invalid trail coordinate encoding");
				if (i += t % 32 * a, t < 32) {
					o = !0;
					break;
				}
				a *= 32;
			}
			if (!o || !Number.isSafeInteger(i)) throw Error("Truncated trail coordinate encoding");
			n[t] += i % 2 ? -(i + 1) / 2 : i / 2;
		}
		let a = n[0] / an, o = n[1] / an;
		if (Math.abs(a) > 540 || Math.abs(o) > 85.05112878) throw Error("Invalid decoded trail coordinate");
		t?.(a, o), i++, i % dn === 0 && (yield);
	}
	if (i < 2) throw Error("Empty trail overlay line");
	return i;
}
function fn(e, t) {
	let n = J(e, t);
	for (;;) {
		let e = n.next();
		if (e.done) return e.value;
	}
}
function pn(e) {
	let t = [];
	return fn(e, (e, n) => t.push([e, n])), t;
}
function mn(e, t) {
	let n = Math.min(t, (e.encoded?.length ?? e.lines.length) - 1);
	return !e.lines[n] && e.encoded && (e.lines[n] = pn(e.encoded[n])), e.lines[n];
}
function Y(e, t) {
	return e[0] <= t[2] && e[2] >= t[0] && e[1] <= t[3] && e[3] >= t[1];
}
var hn = /* @__PURE__ */ new WeakMap();
function gn(e, t) {
	let { point: n, bounds: r, tolerance: i } = t;
	if (![
		n.x,
		n.y,
		t.zoom,
		i,
		...r
	].every(Number.isFinite) || i < 0) return;
	let a = t.zoom <= K[0] ? 0 : t.zoom <= K[1] ? 1 : 2, o;
	for (let s of e) {
		if (!s.ids.length || t.skipId && s.ids.includes(t.skipId)) continue;
		let e = G(s.coastal) && s.key === s.coastal.key ? s.coastal : void 0;
		if (!e && !t.pointerInsideCoverage) continue;
		let c = a === 2 && s.detail ? s.detail : s.parts;
		if (e) {
			let t = hn.get(e);
			t || (t = q(e.geometry).map((e) => ({
				bounds: e.bounds,
				lines: [e.coordinates]
			})), hn.set(e, t)), c = t;
		}
		for (let l of c) {
			if (!Y(l.bounds, r)) continue;
			let c = mn(l, a), u, d = 105;
			for (let a of c) {
				let c = a[0] + 360 * Math.round((d - a[0]) / 360), l = a[1];
				if (d = c, u && Math.min(u.longitude, c) <= r[2] && Math.max(u.longitude, c) >= r[0] && Math.min(u.latitude, l) <= r[3] && Math.max(u.latitude, l) >= r[1]) {
					let r = le(n, t.project(u.longitude, u.latitude), t.project(c, l));
					if (r.distance <= i && (!o || r.distance < o.distance)) {
						let n = t.unproject(r.point);
						(e || t.insideCoverage(n[0], n[1])) && (o = {
							id: s.ids[0],
							distance: r.distance
						});
					}
				}
				u = {
					longitude: c,
					latitude: l
				};
			}
		}
	}
	return o;
}
function _n(e) {
	return Array.isArray(e) && e.length === 4 && e.every(Number.isFinite) && e[0] <= e[2] && e[1] <= e[3];
}
function* vn(e) {
	let t = e;
	if (!t || t.version !== 1 || !Array.isArray(t.sources) || t.sources.length > 5e3) throw Error("Invalid trail overlay catalogue");
	let n = /* @__PURE__ */ new Set(), r = 0, i = [];
	for (let e of t.sources) {
		if (typeof e.key != "string" || !/^[\w-][\w./-]*\.geojson$/.test(e.key) || e.key.includes("..") || n.has(e.key) || !Array.isArray(e.ids) || !e.ids.length || e.ids.some((e) => typeof e != "string" || !e || e.length > 160) || !/^[a-f0-9]{64}$/.test(e.sha256) || !_n(e.bounds) || !Number.isSafeInteger(e.points) || e.points < 2 || !Array.isArray(e.parts) || !e.parts.length || (r += e.parts.length) > 1e5) throw Error("Invalid trail overlay source");
		n.add(e.key);
		let t = [];
		for (let n of e.parts) {
			if (!Array.isArray(n) || n.length !== 3 || !_n(n[0]) || typeof n[1] != "string" || typeof n[2] != "string") throw Error("Invalid trail overlay part");
			yield* J(n[1]), yield* J(n[2]), t.push({
				bounds: n[0],
				lines: [],
				encoded: [n[1], n[2]]
			}), yield;
		}
		i.push({
			...e,
			prepared: {
				key: e.key,
				ids: e.ids,
				parts: t
			}
		});
	}
	return i;
}
function yn() {
	let e = globalThis.scheduler;
	return e?.yield ? e.yield() : new Promise((e) => setTimeout(e, 0));
}
async function bn(e, t = {}) {
	let n = t.budgetMs ?? un;
	if (!Number.isFinite(n) || n <= 0) throw RangeError("Invalid trail preparation budget");
	let r = t.now ?? (() => performance.now()), i = t.yieldControl ?? yn, a = vn(e), o = r();
	for (;;) {
		t.signal?.throwIfAborted();
		let e = a.next();
		if (e.done) return e.value;
		r() - o >= n && (await i(), t.signal?.throwIfAborted(), o = r());
	}
}
var xn = class {
	constructor(e) {
		this.jobs = /* @__PURE__ */ new Map(), this.details = /* @__PURE__ */ new Map(), this.failed = /* @__PURE__ */ new Set(), this.wanted = [], this.disposed = !1, this.error = "", this.options = e;
	}
	update(e) {
		if (!this.disposed) {
			if (this.view = {
				...e,
				ids: [...e.ids],
				bounds: [...e.bounds]
			}, !e.ids.length) {
				this.wanted = [], this.cancelUnwanted(), this.report(""), this.options.onChange([]);
				return;
			}
			if (!this.sources) {
				this.start();
				return;
			}
			this.refresh();
		}
	}
	retry() {
		this.disposed || (this.failed.clear(), this.report(""), this.sources ? this.refresh() : this.start());
	}
	report(e) {
		e !== this.error && (this.error = e, this.options.onError(e));
	}
	start() {
		if (this.overview || this.disposed || !this.view?.ids.length || this.failed.has("overview")) return;
		let e = new AbortController();
		this.overview = e, this.options.load(this.options.url, 1, e.signal).then(async (t) => {
			if (this.disposed || e.signal.aborted) return;
			let n;
			try {
				if (this.options.sha256 !== void 0) {
					if (!/^[a-f0-9]{64}$/.test(this.options.sha256)) throw Error("Invalid trail overlay digest");
					let n = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", t))].map((e) => e.toString(16).padStart(2, "0")).join("");
					if (this.disposed || e.signal.aborted) return;
					if (n !== this.options.sha256) throw Error("Trail overlay integrity mismatch");
				}
				n = await bn(JSON.parse(new TextDecoder().decode(t)), { signal: e.signal });
			} catch (t) {
				throw e.signal.aborted || this.options.invalidate?.(this.options.url), t;
			}
			this.disposed || e.signal.aborted || (this.sources = n, this.report(""), this.refresh());
		}).catch(() => {
			!this.disposed && !e.signal.aborted && (this.failed.add("overview"), this.report("Линии троп не загрузились. Повторите загрузку карты."));
		}).finally(() => {
			this.overview === e && (this.overview = void 0);
		});
	}
	selected() {
		let e = new Set(this.view?.ids);
		return this.sources?.filter((t) => t.ids.some((t) => e.has(t))) ?? [];
	}
	refresh() {
		if (!this.sources || !this.view || this.disposed) return;
		let e = this.selected(), t = this.view, n = new Set(t.ids), r = 0;
		this.wanted = e.filter((e) => (t.zoom > K[1] || tn(e.key, e.sha256)) && !e.ids.includes(t.selectedId ?? "") && Y(e.bounds, t.bounds) && e.parts.some((e) => Y(e[0], t.bounds))).sort((e, n) => {
			let r = (t.bounds[0] + t.bounds[2]) / 2, i = (t.bounds[1] + t.bounds[3]) / 2, a = (e) => Math.hypot((e.bounds[0] + e.bounds[2]) / 2 - r, (e.bounds[1] + e.bounds[3]) / 2 - i);
			return a(e) - a(n) || e.key.localeCompare(n.key);
		}).filter((e) => r + e.points > sn ? !1 : (r += e.points, !0)).slice(0, cn), this.cancelUnwanted(), this.report(this.wanted.some((e) => this.failed.has(e.key)) ? "Часть подробных линий троп не загрузилась. Повторите загрузку." : "");
		let i = new Set(this.wanted.map((e) => e.key)), a = [...this.details.values()].reduce((e, t) => e + t.points, 0);
		for (let [e, t] of this.details) {
			if (a <= sn && this.details.size <= cn) break;
			i.has(e) || (this.details.delete(e), a -= t.points);
		}
		this.options.onChange(e.map((e) => ({
			...e.prepared,
			ids: e.ids.filter((e) => n.has(e)),
			detail: this.details.get(e.key)?.parts,
			coastal: this.details.get(e.key)?.coastal
		}))), this.pump();
	}
	cancelUnwanted() {
		let e = new Set(this.wanted.map((e) => e.key));
		for (let [t, n] of this.jobs) e.has(t) || (n.abort(), this.jobs.delete(t));
	}
	pump() {
		if (!this.disposed) for (let e of this.wanted) {
			if (this.jobs.size >= ln) break;
			if (this.details.has(e.key) || this.jobs.has(e.key) || this.failed.has(e.key)) continue;
			let t = new AbortController();
			this.jobs.set(e.key, t);
			let n = `${on}${e.key}?v=${e.sha256.slice(0, 16)}`;
			this.options.load(n, 2, t.signal).then(async (r) => {
				if (this.disposed || t.signal.aborted || this.jobs.get(e.key) !== t) return;
				let i, a;
				try {
					let n = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", r))].map((e) => e.toString(16).padStart(2, "0")).join("");
					if (this.disposed || t.signal.aborted || this.jobs.get(e.key) !== t) return;
					if (n !== e.sha256) throw Error("Detailed trail source integrity mismatch");
					if (a = O(JSON.parse(new TextDecoder().decode(r))), i = q(a), !i.length) throw Error("Empty detailed trail geometry");
				} catch (e) {
					throw this.options.invalidate?.(n), e;
				}
				let o = tn(e.key, e.sha256) ? await rn(on + e.key, a) : void 0;
				this.disposed || t.signal.aborted || this.jobs.get(e.key) !== t || (this.details.delete(e.key), this.details.set(e.key, {
					parts: i.map((e) => ({
						bounds: e.bounds,
						lines: [e.coordinates]
					})),
					points: i.reduce((e, t) => e + t.coordinates.length, 0),
					coastal: o
				}));
			}).catch(() => {
				!this.disposed && !t.signal.aborted && this.failed.add(e.key);
			}).finally(() => {
				this.jobs.get(e.key) === t && this.jobs.delete(e.key), !this.disposed && !t.signal.aborted && this.refresh();
			});
		}
	}
	inspect() {
		return {
			sources: this.sources?.length ?? 0,
			visibleSources: this.selected().length,
			pending: this.jobs.size,
			detailSources: this.details.size,
			detailPoints: [...this.details.values()].reduce((e, t) => e + t.points, 0)
		};
	}
	destroy() {
		this.disposed = !0, this.overview?.abort();
		for (let e of this.jobs.values()) e.abort();
		this.jobs.clear(), this.details.clear(), this.sources = void 0, this.view = void 0;
	}
}, Sn = /* @__PURE__ */ new WeakMap(), Cn = (e, t) => e.left <= t.right && e.right >= t.left && e.top <= t.bottom && e.bottom >= t.top;
function wn(e) {
	if (e.length < 3) return;
	let t = new Float64Array(e.length * 2), n = {
		left: Infinity,
		top: Infinity,
		right: -Infinity,
		bottom: -Infinity
	}, r = 105;
	for (let i = 0; i < e.length; i++) {
		let a = e[i];
		if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) return;
		let o = a[0] + 360 * Math.round((r - a[0]) / 360);
		r = o;
		let s;
		try {
			s = d([o, a[1]]);
		} catch {
			return;
		}
		t[i * 2] = s.x, t[i * 2 + 1] = s.y, n.left = Math.min(n.left, s.x), n.top = Math.min(n.top, s.y), n.right = Math.max(n.right, s.x), n.bottom = Math.max(n.bottom, s.y);
	}
	return {
		points: t,
		bounds: n
	};
}
function Tn(e) {
	let t = Sn.get(e);
	if (t) return t;
	let n = {
		valid: !0,
		polygons: []
	};
	if (e.type === "Feature" || e.type === "FeatureCollection" || e.type === "GeometryCollection") {
		if (e.type === "Feature" && !e.geometry) return {
			valid: !1,
			polygons: []
		};
		let t = e.type === "Feature" ? e.geometry ? [e.geometry] : [] : e.type === "FeatureCollection" ? e.features : e.geometries;
		for (let e of t) {
			let t = Tn(e);
			n.valid &&= t.valid, n.polygons.push(...t.polygons);
		}
	} else if (e.type === "Polygon" || e.type === "MultiPolygon") for (let t of e.type === "Polygon" ? [e.coordinates] : e.coordinates) {
		let e = t.map(wn);
		if (!e.length || e.some((e) => !e)) {
			n.valid = !1;
			continue;
		}
		let r = e;
		n.polygons.push({
			rings: r,
			bounds: r[0].bounds
		});
	}
	else n = {
		valid: !1,
		polygons: []
	};
	return Sn.set(e, n), n;
}
function En(e, t, n, r, i) {
	let a = 0, o = 1, s = n - e, c = r - t, l = [
		-s,
		s,
		-c,
		c
	], u = [
		e - i.left,
		i.right - e,
		t - i.top,
		i.bottom - t
	];
	for (let e = 0; e < 4; e++) {
		if (l[e] === 0) {
			if (u[e] < 0) return !1;
			continue;
		}
		let t = u[e] / l[e];
		if (l[e] < 0 ? a = Math.max(a, t) : o = Math.min(o, t), a > o) return !1;
	}
	return !0;
}
function Dn(e, t) {
	if (!Cn(e.bounds, t)) return !1;
	let n = e.points;
	for (let e = 0, r = n.length - 2; e < n.length; r = e, e += 2) if (En(n[r], n[r + 1], n[e], n[e + 1], t)) return !0;
	return !1;
}
function On(e, t, n) {
	let r = n.points, i = !1;
	for (let n = 0, a = r.length - 2; n < r.length; a = n, n += 2) {
		let o = r[a], s = r[a + 1], c = r[n], l = r[n + 1];
		s > t != l > t && e < (c - o) * (t - s) / (l - s) + o && (i = !i);
	}
	return i;
}
function kn(e, t, n, r = 0) {
	if (!e || typeof e != "object" || !Number.isInteger(t.z) || t.z < 0 || t.z > 18 || !Number.isSafeInteger(t.x) || !Number.isInteger(t.y) || t.y < 0 || t.y >= 2 ** t.z || !Number.isFinite(n) || !Number.isFinite(r) || r < 0 || r > 60) return !0;
	let i = 2 ** t.z, a = 2 / (256 * 2 ** n * Math.cos(r * Math.PI / 180)), o = {
		left: t.x / i - a,
		top: t.y / i - a,
		right: (t.x + 1) / i + a,
		bottom: (t.y + 1) / i + a
	};
	if (!Number.isFinite(a) || a <= 0) return !0;
	let s;
	try {
		s = Tn(e);
	} catch {
		return !0;
	}
	if (!s.valid) return !0;
	for (let e of s.polygons) if (Cn(e.bounds, o) && (e.rings.some((e) => Dn(e, o)) || On(o.left, o.top, e.rings[0]) && !e.rings.slice(1).some((e) => On(o.left, o.top, e)))) return !0;
	return !1;
}
//#endregion
//#region web/lib/map-point-marker-layout.ts
function An(e, t, n = !1, r = !1) {
	if (r) return {
		left: e.x - 24,
		top: e.y - 24,
		right: e.x + 24,
		bottom: e.y + 24
	};
	if (t === "plan") return {
		left: e.x - 20,
		top: e.y - 20,
		right: e.x + 20,
		bottom: e.y + 20
	};
	let i = t === "position" ? n ? 20 : 18 : n ? 17 : 14, a = e.x + 3, o = e.y + 3;
	return {
		left: a - i,
		top: o - i,
		right: a + i,
		bottom: o + i
	};
}
"" + new URL("../workers/custom-map-trail-raster.worker-CZZMbu81.js", import.meta.url).href;
//#endregion
//#region web/lib/custom-map-trail-raster.ts
var X = Object.freeze({
	bitmapBytes: 64 * 1024 * 1024,
	entries: 3,
	frameBytes: 32 * 1024 * 1024,
	sourceBytes: 32 * 1024 * 1024,
	parts: 1e5,
	dimension: 16384,
	timeoutMs: 15e3
}), jn = (e) => e instanceof Error ? e.message : String(e), Mn = class {
	constructor(e) {
		this.options = e, this.serial = 0, this.disposed = !1, this.notification = !1, this.error = "", this.invalidError = "", this.bytes = 0, this.cache = /* @__PURE__ */ new Map(), this.geometry = /* @__PURE__ */ new WeakMap(), this.registered = /* @__PURE__ */ new Map(), this.closed = /* @__PURE__ */ new WeakSet();
		let t = e.timeoutMs ?? X.timeoutMs;
		this.timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, X.timeoutMs) : X.timeoutMs;
	}
	getState() {
		let e = !!this.desired && this.cache.has(this.desired.key);
		return {
			ready: e,
			pending: !!this.desired && !e && !this.error && !this.disposed,
			error: this.error
		};
	}
	request(e) {
		if (this.disposed) return;
		let t;
		try {
			t = this.prepare(e);
		} catch (e) {
			let t = "Trail overlay raster: " + jn(e), n = this.invalidError !== t;
			this.desired = void 0, this.latest = void 0, this.failedKey = void 0, this.invalidError = t, this.error = t, n && this.notify();
			return;
		}
		this.invalidError = "", this.desired?.key !== t.key && (this.error = "", this.failedKey = void 0), this.desired = t;
		let n = this.cache.get(t.key);
		if (n) return this.cache.delete(t.key), this.cache.set(t.key, n), this.latest = void 0, this.error = "", this.failedKey = void 0, n.snapshot;
		if (this.failedKey !== t.key) {
			if (this.active) {
				this.latest = this.active.frame.key === t.key ? void 0 : t;
				return;
			}
			this.latest = void 0, this.dispatch(t);
		}
	}
	clear() {
		this.desired = void 0, this.latest = void 0, this.error = "", this.failedKey = void 0, this.invalidError = "";
	}
	retry() {
		if (this.disposed) return;
		this.error = "", this.failedKey = void 0, this.invalidError = "";
		let e = this.desired;
		e && !this.cache.has(e.key) && (this.active ? this.latest = this.active.frame.key === e.key ? void 0 : e : this.dispatch(e)), this.notify();
	}
	destroy() {
		if (!this.disposed) {
			this.disposed = !0, clearTimeout(this.timer), this.timer = void 0, this.worker?.terminate(), this.worker = void 0, this.active = void 0, this.latest = void 0, this.desired = void 0;
			for (let e of this.cache.values()) this.close(e.snapshot.bitmap);
			this.cache.clear(), this.bytes = 0, this.registered.clear(), this.geometry = /* @__PURE__ */ new WeakMap(), this.error = "";
		}
	}
	notify() {
		this.notification || this.disposed || (this.notification = !0, queueMicrotask(() => {
			this.notification = !1, this.disposed || this.options.onChange();
		}));
	}
	close(e) {
		if (!(!e || typeof e != "object" || this.closed.has(e))) {
			this.closed.add(e);
			try {
				e.close();
			} catch {}
		}
	}
	evict(e) {
		let t = this.cache.get(e);
		t && (this.cache.delete(e), this.bytes -= t.frame.bytes, this.close(t.snapshot.bitmap));
	}
	prepare(e) {
		let { width: t, height: n, transform: r, haloWidth: i, lineWidth: a, haloColor: o, lineColor: s } = e;
		if (!Number.isInteger(t) || !Number.isInteger(n) || t <= 0 || n <= 0 || t > X.dimension || n > X.dimension) throw Error("Invalid backing dimensions");
		let c = t * n * 4;
		if (c > X.frameBytes) throw Error("Backing frame exceeds the 32 MiB budget");
		if (!Array.isArray(r) || r.length !== 6 || !r.every(Number.isFinite) || !Number.isFinite(r[0] * r[3] - r[1] * r[2]) || r[0] * r[3] === r[1] * r[2]) throw Error("Invalid world-to-backing transform");
		if (![i, a].every((e) => Number.isFinite(e) && e > 0) || i < a) throw Error("Invalid trail stroke widths");
		if (![o, s].every((e) => typeof e == "string" && e.length > 0 && e.length <= 128)) throw Error("Invalid trail colors");
		let l = this.geometry.get(e.parts);
		if (!l) {
			if (!Array.isArray(e.parts) || e.parts.length > X.parts) throw Error("Trail part budget exceeded");
			let t = /* @__PURE__ */ new Map(), n = [], r = 0;
			for (let i of e.parts) {
				if (!Number.isSafeInteger(i.id) || i.id <= 0 || !(i.points instanceof Float64Array) || i.points.length < 4 || i.points.length % 2) throw Error("Invalid projected trail part");
				let e = t.get(i.id);
				if (e && e.points !== i.points || this.registered.has(i.id) && this.registered.get(i.id).points !== i.points) throw Error("A trail part identity changed");
				if (!e) {
					if (r += i.points.byteLength, r > X.sourceBytes) throw Error("Projected trail sources exceed the 32 MiB budget");
					if (!i.points.every(Number.isFinite)) throw Error("Invalid projected trail coordinate");
					t.set(i.id, i);
				}
				n.push(i.id);
			}
			l = {
				key: n.join(","),
				ids: n,
				parts: [...t.values()],
				bytes: r
			}, this.geometry.set(e.parts, l);
		}
		let u = [
			r[0],
			r[1],
			r[2],
			r[3],
			r[4],
			r[5]
		], d = l.key + "|" + JSON.stringify([
			t,
			n,
			u,
			i,
			a,
			o,
			s
		]), f = this.cache.get(d)?.frame.geometry;
		if (f && f !== l && f.parts.some((e, t) => e.id !== l.parts[t]?.id || e.points !== l.parts[t]?.points)) throw Error("A cached trail part identity changed");
		return {
			key: d,
			geometry: l,
			width: t,
			height: n,
			transform: u,
			haloWidth: i,
			lineWidth: a,
			haloColor: o,
			lineColor: s,
			bytes: c
		};
	}
	ensureWorker() {
		if (this.worker) return this.worker;
		let e = this.options.createWorker?.() ?? new Worker(new URL("" + new URL("../workers/custom-map-trail-raster.worker-CZZMbu81.js", import.meta.url).href, location.href), {
			type: "module",
			name: "tropnik-trail-overlay"
		});
		return this.worker = e, e.onmessage = (t) => this.receive(e, t.data), e.onerror = (t) => {
			this.worker === e && this.failWorker("Worker failed: " + (t.message || "Unknown worker error"));
		}, e.onmessageerror = () => {
			this.worker === e && this.failWorker("Worker message could not be decoded");
		}, e;
	}
	retained(e) {
		let t = () => {
			let t = /* @__PURE__ */ new Map(), n = 0;
			for (let r of [e.geometry, ...[...this.cache.values()].map((e) => e.frame.geometry)]) for (let e of r.parts) {
				let r = t.get(e.id) ?? this.registered.get(e.id);
				if (r && r.points !== e.points) throw Error("A registered trail part identity changed");
				t.has(e.id) || (t.set(e.id, e), n += e.points.byteLength);
			}
			return {
				parts: t,
				bytes: n
			};
		}, n = t();
		for (; (n.bytes > X.sourceBytes || n.parts.size > X.parts) && this.cache.size;) this.evict(this.cache.keys().next().value), n = t();
		if (n.bytes > X.sourceBytes || n.parts.size > X.parts) throw Error("Retained trail sources exceed their budget");
		return n.parts;
	}
	dispatch(e) {
		if (!(this.disposed || this.active || this.desired?.key !== e.key)) try {
			let t = this.retained(e), n = this.ensureWorker(), r = [...this.registered.keys()].filter((e) => !t.has(e)), i = [], a = [];
			for (let t of e.geometry.parts) if (!this.registered.has(t.id)) {
				let e = t.points.slice();
				i.push({
					id: t.id,
					points: e
				}), a.push(e.buffer);
			}
			for (let e of r) this.registered.delete(e);
			for (let t of e.geometry.parts) this.registered.set(t.id, t);
			let o = ++this.serial;
			this.active = {
				id: o,
				frame: e
			}, this.timer = setTimeout(() => {
				this.active?.id === o && this.failWorker("Worker paint exceeded its deadline");
			}, this.timeoutMs);
			let s = {
				id: o,
				width: e.width,
				height: e.height,
				transform: e.transform,
				haloWidth: e.haloWidth,
				lineWidth: e.lineWidth,
				haloColor: e.haloColor,
				lineColor: e.lineColor,
				softwareRaster: !!this.options.softwareRaster,
				partIds: e.geometry.ids,
				addParts: i,
				dropPartIds: r
			};
			n.postMessage(s, a);
		} catch (e) {
			this.failWorker(jn(e));
		}
	}
	receive(e, t) {
		let n = this.active;
		if (this.disposed || this.worker !== e || !n || t?.id !== n.id) {
			this.close(t?.bitmap);
			return;
		}
		clearTimeout(this.timer), this.timer = void 0, this.active = void 0;
		let r = this.desired?.key === n.frame.key;
		if (t.bitmap && t.bitmap.width === n.frame.width && t.bitmap.height === n.frame.height && !t.error) if (r) {
			let e = {
				key: n.frame.key,
				bitmap: t.bitmap,
				width: n.frame.width,
				height: n.frame.height
			};
			for (this.evict(n.frame.key), this.cache.set(n.frame.key, {
				frame: n.frame,
				snapshot: e
			}), this.bytes += n.frame.bytes; this.cache.size > X.entries || this.bytes > X.bitmapBytes;) this.evict(this.cache.keys().next().value);
			this.error = "", this.failedKey = void 0, this.notify();
		} else this.close(t.bitmap);
		else this.close(t.bitmap), e.terminate(), this.worker = void 0, this.registered.clear(), r && (this.error = "Trail overlay raster: " + (t.error || "Worker returned an invalid bitmap"), this.failedKey = n.frame.key, this.notify());
		let i = this.latest;
		this.latest = void 0, i && this.desired?.key === i.key && !this.cache.has(i.key) && this.failedKey !== i.key && this.dispatch(i);
	}
	failWorker(e) {
		clearTimeout(this.timer), this.timer = void 0, this.worker?.terminate(), this.worker = void 0, this.active = void 0, this.latest = void 0, this.registered.clear(), this.desired && !this.cache.has(this.desired.key) && (this.error = "Trail overlay raster: " + e, this.failedKey = this.desired.key, this.notify());
	}
}, Z = 64, Nn = 4096, Pn = 32 * 1024 * 1024;
function Q(e) {
	let t = new Path2D(), n = [
		Infinity,
		Infinity,
		-Infinity,
		-Infinity
	], r = (e, r = !1) => {
		if (!e.length) return;
		let i = 105;
		for (let r = 0; r < e.length; r++) {
			let a = e[r];
			if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) continue;
			let o = a[0] + 360 * Math.round((i - a[0]) / 360);
			i = o;
			let s = d([o, a[1]]);
			r ? t.lineTo(s.x, s.y) : t.moveTo(s.x, s.y), n[0] = Math.min(n[0], o), n[1] = Math.min(n[1], a[1]), n[2] = Math.max(n[2], o), n[3] = Math.max(n[3], a[1]);
		}
		r && t.closePath();
	}, i = (e) => {
		if (e) {
			if (e.type === "FeatureCollection") {
				e.features.forEach(i);
				return;
			}
			if (e.type === "Feature") {
				i(e.geometry);
				return;
			}
			if (e.type === "GeometryCollection") {
				e.geometries.forEach(i);
				return;
			}
			e.type === "LineString" ? r(e.coordinates) : e.type === "MultiLineString" ? e.coordinates.forEach((e) => r(e)) : e.type === "Polygon" ? e.coordinates.forEach((e) => r(e, !0)) : e.type === "MultiPolygon" && e.coordinates.forEach((e) => e.forEach((e) => r(e, !0)));
		}
	};
	return i(e), {
		path: t,
		bounds: n
	};
}
function $(e, t, n, r, i = !0, a = !1, o = !0) {
	let s = Math.max(0, Math.floor(n)), c = w(e, t), l = d([c[0], c[1]]), u = d([c[2], c[3]]), f = d(e.center), p = (e.bearingDegrees ?? 0) * Math.PI / 180, m = Math.cos(p), h = Math.sin(p), g = 256 * 2 ** e.zoom, _ = t.width / 2, v = t.height / 2, y = [], b = (e, t, n) => {
		let r = ((e + .5) / n - f.x) * g, i = ((t + .5) / n - f.y) * g, a = g / (2 * n), o = a * (Math.abs(m) + Math.abs(h));
		return Math.abs(r * m + i * h) <= _ + o && Math.abs(-r * h + i * m) <= v + o && Math.abs(r) <= a + _ * Math.abs(m) + v * Math.abs(h) && Math.abs(i) <= a + _ * Math.abs(h) + v * Math.abs(m);
	};
	for (; s >= 0; s--) {
		let e = 2 ** s, t = Math.floor(l.x * e), c = Math.floor(u.x * e), d = Math.max(0, Math.floor(u.y * e)), f = Math.min(e - 1, Math.floor(l.y * e));
		if (y = [], !((c - t + 1) * (f - d + 1) > Z * 4 && s > 0)) {
			outer: for (let l = d; l <= f; l++) for (let u = t; u <= c; u++) if (b(u, l, e) && (y.push({
				kind: r,
				z: s,
				x: u,
				y: l,
				paths: i,
				transparent: a,
				...r === "vector" ? { boundaries: o } : {},
				...r === "vector" || r === "relief" ? { paintZoom: Math.max(s, Math.min(18, Math.floor(n))) } : {}
			}), y.length > Z && s > 0)) break outer;
			if (y.length <= Z || s === 0) break;
		}
	}
	let x = 2 ** s;
	return y.sort((e, t) => Math.hypot(e.x + .5 - f.x * x, e.y + .5 - f.y * x) - Math.hypot(t.x + .5 - f.x * x, t.y + .5 - f.y * x));
}
var Fn = class {
	constructor(e, t) {
		this.framed = null, this.pitch = 0, this.padding = {}, this.size = {
			width: 1,
			height: 1
		}, this.pixelRatio = 1, this.retryAfterCurrent = !1, this.coverageRevision = -1, this.coveragePaths = /* @__PURE__ */ new WeakMap(), this.reviewedCoastalPaths = /* @__PURE__ */ new WeakMap(), this.reviewedCoastalOverlaySources = 0, this.trailOverlay = [], this.trailOverlayPaths = /* @__PURE__ */ new WeakMap(), this.trailOverlayLevel = -1, this.trailOverlaySources = 0, this.trailOverlayParts = 0, this.trailOverlayDetails = 0, this.trailOverlayCandidateCounts = {
			sources: 0,
			parts: 0,
			details: 0
		}, this.trailRasterPartCache = /* @__PURE__ */ new WeakMap(), this.trailRasterPartSerial = 0, this.trailOverlayPaintedEntries = [], this.trailOverlayViewportReady = !0, this.trailRasterError = "", this.groundSnapshotUnavailable = !1, this.markers = /* @__PURE__ */ new Map(), this.markerGroups = /* @__PURE__ */ new Map(), this.routeEdges = [], this.selectedShapes = [], this.mode = "detail", this.paths = !0, this.boundaryVisible = !0, this.reliefVisible = !0, this.generation = 0, this.currentKeys = "", this.disposed = !1, this.active = !0, this.eco = !1, this.additionalLabels = [], this.labelDiagnostics = [], this.labelDiagnosticTotal = 0, this.drawRevision = 0, this.labelRevision = 0, this.frame = 0, this.paintRequested = !1, this.labelsRequested = !1, this.animation = 0, this.zoomTarget = null, this.pointer = new ae({
			minZoom: -2,
			maxZoom: 18,
			rotate: !0
		}), this.pointerMoved = !1, this.listeners = [], this.obstacles = [], this.markerObstacles = [], this.state = {
			ready: !1,
			loading: !1,
			mode: "detail",
			committedMode: "overview",
			imageryLoading: !1,
			reliefReady: !1,
			localDetail: !1,
			error: "",
			residentTiles: 0,
			pendingTiles: 0
		}, this.element = e, this.options = t, this.camera = { ...t.camera }, this.floor = { ...t.camera }, this.rasterPolicy = Jt(e.ownerDocument ?? document), this.tiles = new ot(this.rasterPolicy.softwareRaster), this.canvas = document.createElement("canvas"), this.canvas.className = "tropnik-map-canvas", this.canvas.tabIndex = 0, this.canvas.setAttribute("aria-label", "Карта России: перетаскивание и стрелки перемещают карту, колёсико и плюс или минус меняют масштаб."), this.canvas.setAttribute("role", "img"), e.appendChild(this.canvas), this.labelCanvas = document.createElement("canvas"), this.labelCanvas.className = "tropnik-map-labels", this.labelCanvas.hidden = !0, this.labelCanvas.setAttribute("aria-hidden", "true"), e.appendChild(this.labelCanvas), this.markerLayer = document.createElement("div"), this.markerLayer.className = "tropnik-marker-layer", e.appendChild(this.markerLayer);
		let n = this.canvas.getContext("2d", {
			alpha: !1,
			willReadFrequently: this.rasterPolicy.softwareRaster
		});
		if (!n) throw Error("Canvas map is unavailable");
		this.context = n;
		let r = this.labelCanvas.getContext("2d", {
			alpha: !0,
			willReadFrequently: this.rasterPolicy.softwareRaster
		});
		if (!r) throw Error("Canvas map labels are unavailable");
		this.labelContext = r, this.resize = new ResizeObserver(() => this.resizeCanvas()), this.resize.observe(e), this.resizeCanvas(), this.bindInput(), this.loadCoverage();
	}
	loadCoverage() {
		this.disposed || this.coverage || this.coverageTask || (this.updateState({ loading: !0 }), this.coverageTask = st().then((e) => {
			if (this.disposed) {
				e.dispose();
				return;
			}
			this.coverage = e, this.applyCoverage(), this.unbindCoverage = e.subscribe(() => this.applyCoverage()), this.updateState({
				ready: !0,
				loading: !1,
				error: ""
			}), this.options.onReady?.(this), this.schedule(), this.settled();
		}).catch(() => this.updateState({
			loading: !1,
			error: "Границы карты не загрузились. Проверьте подключение и повторите загрузку."
		})).finally(() => {
			this.coverageTask = void 0, this.retryAfterOnline();
		}));
	}
	retry() {
		if (!this.disposed) {
			if (this.trailRaster?.retry(), this.schedule(), !this.coverage) {
				this.loadCoverage();
				return;
			}
			this.state.loading || (this.currentKeys = "", this.refreshTiles());
		}
	}
	retryAfterOnline() {
		this.retryAfterCurrent && (this.retryAfterCurrent = !1, this.state.error && this.retry());
	}
	getCamera() {
		return {
			...this.camera,
			center: [...this.camera.center]
		};
	}
	getSize() {
		return { ...this.size };
	}
	getBounds() {
		return w(this.camera, this.virtualSize());
	}
	getVisibleBounds(e = this.padding) {
		let t = Math.cos(this.pitch * Math.PI / 180);
		return w(this.camera, this.virtualSize(), {
			...e,
			top: (e.top ?? 0) / t,
			bottom: (e.bottom ?? 0) / t
		});
	}
	getPitch() {
		return this.pitch;
	}
	getCoverage() {
		return this.coverage;
	}
	getState() {
		return { ...this.state };
	}
	inspect() {
		let e = (e) => e?.tiles.map((e) => {
			let t = 2 ** e.z, n = f({
				x: e.x / t,
				y: (e.y + 1) / t
			}), r = f({
				x: (e.x + 1) / t,
				y: e.y / t
			});
			return {
				key: e.key,
				kind: e.kind,
				z: e.z,
				x: e.x,
				y: e.y,
				local: e.local,
				width: e.bitmap.width,
				height: e.bitmap.height,
				bounds: [
					n[0],
					n[1],
					r[0],
					r[1]
				],
				transparent: !!e.transparent,
				...e.reliefCoverage ? { reliefCoverage: e.reliefCoverage } : {}
			};
		}) || [], t = {
			top: this.padding.top ?? 0,
			right: this.padding.right ?? 0,
			bottom: this.padding.bottom ?? 0,
			left: this.padding.left ?? 0
		}, n = Object.values(t).every((e) => Number.isFinite(e) && e >= 0) && t.left + t.right < this.size.width && t.top + t.bottom < this.size.height;
		return {
			engine: "tropnik-canvas",
			rasterPolicy: this.rasterPolicy,
			contextAttributes: this.context.getContextAttributes?.() ?? null,
			camera: this.getCamera(),
			pitch: this.pitch,
			viewport: {
				...this.size,
				padding: t
			},
			visibleBounds: n ? this.getVisibleBounds(t) : null,
			state: this.getState(),
			coverage: this.coverage?.status,
			routeId: this.routeId || "",
			drawnRoute: this.element.dataset.mapDrawnRoute || "",
			catalogueOverlay: {
				sources: this.trailOverlay.length,
				preparedSources: this.paths ? this.trailOverlaySources : 0,
				preparedParts: this.paths ? this.trailOverlayParts : 0,
				exactSources: this.paths ? this.trailOverlayDetails : 0,
				currentViewportReady: !this.paths || this.trailOverlayViewportReady,
				pending: !!(this.paths && this.trailRasterParts?.length && this.trailRaster?.getState().pending),
				error: this.paths ? this.trailRasterError : ""
			},
			reviewedCoastal: {
				selected: !!this.reviewedCoastalRoute,
				overlaySources: this.paths ? this.reviewedCoastalOverlaySources : 0
			},
			drawRevision: this.drawRevision,
			labelRevision: this.labelRevision,
			tiles: {
				overview: e(this.overview),
				detail: e(this.displayDetail()),
				relief: e(this.relief),
				imagery: e(this.imagery)
			},
			labels: this.getLabelDiagnostics(),
			resources: this.tiles.snapshot()
		};
	}
	publishInspection() {
		this.disposed || (this.element.dataset.mapTilesState = this.state.loading ? "loading" : this.state.error ? "error" : "ready", this.element.dataset.mapInspection = JSON.stringify(this.inspect()));
	}
	setMoving(e) {
		this.element.dataset.mapMoving = String(e), e ? this.element.dataset.mapCamera = "moving" : delete this.element.dataset.mapCamera;
	}
	setActive(e) {
		this.active !== e && (this.active = e, this.tiles.setActive(e), e ? (this.schedule(), this.settled()) : (this.markerPointer = void 0, this.pointer.cancel(), this.stopAnimation(), cancelAnimationFrame(this.frame), this.frame = 0, clearTimeout(this.settleTimer), this.setMoving(!1)));
	}
	setEco(e) {
		this.eco !== e && (this.eco = e, this.canvas.width = 1, this.resizeCanvas());
	}
	setLabels(e) {
		this.additionalLabels = e.slice(0, 256).map((e) => ({
			...e,
			coordinate: [...e.coordinate]
		})), this.scheduleLabels();
	}
	getLabelDiagnostics() {
		return this.labelDiagnostics.slice(0, 512).map(Zt);
	}
	inspectLabels(e) {
		let t = Qt(this.labelDiagnostics, this.labelDiagnosticTotal, e);
		if (!t) return { error: "Invalid label inspection request" };
		let { candidates: n, ...r } = t;
		return {
			...this.inspect(),
			labels: n,
			labelInspection: r
		};
	}
	project(e) {
		let t = g(this.camera, this.size, e);
		return {
			x: t.x,
			y: this.size.height / 2 + (t.y - this.size.height / 2) * Math.cos(this.pitch * Math.PI / 180)
		};
	}
	unproject(e) {
		return _(this.camera, this.size, this.flatPoint(e));
	}
	flatPoint(e) {
		return {
			x: e.x,
			y: this.size.height / 2 + (e.y - this.size.height / 2) / Math.cos(this.pitch * Math.PI / 180)
		};
	}
	virtualSize() {
		return {
			width: this.size.width,
			height: this.size.height / Math.cos(this.pitch * Math.PI / 180)
		};
	}
	setPitch(e) {
		Number.isFinite(e) && (this.pitch = Math.max(0, Math.min(60, e)), this.element.dataset.mapPitch = String(this.pitch), this.currentKeys = "", this.pointer.cancel(), this.settled());
	}
	setPadding(e) {
		[
			"top",
			"right",
			"bottom",
			"left"
		].every((t) => (e[t] ?? 0) === (this.padding[t] ?? 0)) || (this.padding = { ...e }, this.publishInspection());
	}
	setFloor(e) {
		this.floor = { ...e };
	}
	setObstacles(e) {
		e.length === this.obstacles.length && e.every((e, t) => {
			let n = this.obstacles[t];
			return e.left === n.left && e.top === n.top && e.right === n.right && e.bottom === n.bottom;
		}) || (this.obstacles = e.map((e) => ({ ...e })), this.scheduleLabels());
	}
	stopAnimation() {
		cancelAnimationFrame(this.animation), this.animation = 0, this.zoomTarget = null;
	}
	setCamera(e, t = !1) {
		this.moveCamera(e, t);
	}
	moveCamera(e, t, n) {
		if (this.disposed) return;
		this.pointer.cancel(), this.stopAnimation();
		let r = z(e.center[0], e.center[1], e.zoom, {
			...this.floor,
			center: [...this.floor.center]
		}, this.framed ? {
			...this.framed,
			center: [...this.framed.center]
		} : null), i = {
			center: r.center,
			zoom: Math.min(this.options.maxZoom ?? 18, r.zoom),
			bearingDegrees: e.bearingDegrees ?? 0
		};
		if (!t || !this.active || this.eco || matchMedia("(prefers-reduced-motion: reduce)").matches) {
			this.camera = i, this.schedule(), this.settled();
			return;
		}
		let a = this.getCamera(), o = d(a.center), s = d(i.center), c = performance.now();
		this.zoomTarget = n ? i.zoom : null, this.setMoving(!0);
		let l = () => {
			if (this.disposed) return;
			let e = Math.min(1, (performance.now() - c) / 240), t = 1 - (1 - e) ** 3, r = a.zoom + (i.zoom - a.zoom) * t;
			if (n) {
				let e = S(a, this.size, r, n, {
					minZoom: this.floor.zoom,
					maxZoom: this.options.maxZoom ?? 18
				}), t = z(e.center[0], e.center[1], e.zoom, {
					...this.floor,
					center: [...this.floor.center]
				}, this.framed ? {
					...this.framed,
					center: [...this.framed.center]
				} : null);
				this.camera = {
					...e,
					center: t.center,
					zoom: t.zoom
				};
			} else this.camera = {
				center: f({
					x: o.x + (s.x - o.x) * t,
					y: o.y + (s.y - o.y) * t
				}),
				zoom: r,
				bearingDegrees: (a.bearingDegrees ?? 0) + ((i.bearingDegrees ?? 0) - (a.bearingDegrees ?? 0)) * t
			};
			this.draw(), e < 1 ? this.animation = requestAnimationFrame(l) : (this.animation = 0, this.zoomTarget = null, this.settled());
		};
		this.animation = requestAnimationFrame(l);
	}
	fit(e, t = {}, n = 14, r = !0) {
		this.padding = t, this.framed = C(e, this.size, {
			padding: t,
			maxZoom: n,
			minZoom: this.floor.zoom,
			referenceLongitude: 105
		}), this.setCamera(this.framed, r);
	}
	zoomBy(e) {
		if (this.disposed || !Number.isFinite(e) || (this.options.onBeforeZoom?.(), this.disposed)) return;
		let t = (this.zoomTarget ?? this.camera.zoom) + e, n = this.padding.left ?? 0, r = this.padding.right ?? 0, i = this.padding.top ?? 0, a = this.padding.bottom ?? 0, o = [
			n,
			r,
			i,
			a
		].every((e) => Number.isFinite(e) && e >= 0) && n + r < this.size.width && i + a < this.size.height ? {
			x: (this.size.width + n - r) / 2,
			y: (this.size.height + i - a) / 2
		} : {
			x: this.size.width / 2,
			y: this.size.height / 2
		};
		this.options.onGesture?.();
		let s = this.flatPoint(o);
		this.moveCamera(S(this.camera, this.size, t, s, {
			minZoom: this.floor.zoom,
			maxZoom: this.options.maxZoom ?? 18
		}), !0, s);
	}
	north() {
		this.options.onGesture?.(), this.setCamera({
			...this.camera,
			bearingDegrees: 0
		}, !0);
	}
	setMode(e) {
		if (this.mode === e) {
			this.state.error && this.retry();
			return;
		}
		this.mode = e, this.currentKeys = "", e === "overview" && (this.detail = void 0, this.relief = void 0, this.imagery = void 0, this.imageryOverlay = void 0, this.updateState({
			committedMode: "overview",
			reliefReady: !1,
			localDetail: !1,
			imagerySource: void 0
		})), this.updateState({
			mode: e,
			imageryLoading: !1,
			imageryTarget: void 0
		}), this.refreshTiles(), this.schedule();
	}
	setLayers(e) {
		e.paths !== void 0 && e.paths !== this.paths && (this.paths = e.paths, this.currentKeys = "", this.paths || (this.trailRaster?.clear(), this.updateTrailRasterError(), this.trailOverlayPaintedEntries = [])), e.boundaries !== void 0 && e.boundaries !== this.boundaryVisible && (this.boundaryVisible = e.boundaries, this.currentKeys = ""), e.relief !== void 0 && (this.reliefVisible = e.relief), this.refreshTiles(), this.schedule();
	}
	setRegion(e = []) {
		this.selectedShapes = [...e], this.updateSelectedArea(), this.schedule();
	}
	setRoute(e, t, n) {
		let r = e ? Q(e) : void 0;
		if (this.route = r?.bounds.every(Number.isFinite) ? r : void 0, this.routeId = this.route ? t : void 0, this.element.dataset.mapRouteId = this.routeId || "", this.reviewedCoastalRoute = e && G(n, e) ? Q(n.geometry) : void 0, this.routeHit = this.route && e && t ? {
			key: this.reviewedCoastalRoute && n ? n.key : "selected",
			ids: [t],
			parts: q(e).map((e) => ({
				bounds: e.bounds,
				lines: [e.coordinates]
			})),
			coastal: this.reviewedCoastalRoute ? n : void 0
		} : void 0, this.routeEdges.forEach((e) => e.element.remove()), this.routeEdges = [], e) for (let t of ut(e)) {
			let e = dt(t);
			this.markerLayer.appendChild(e), this.routeEdges.push({
				element: e,
				project: () => this.project(t.coordinate)
			});
		}
		this.trailOverlayWindow = void 0, this.trailRaster?.clear(), this.trailOverlayPaintedEntries = [], this.schedule();
	}
	pickTrail(e, t = 8) {
		if (this.disposed || !this.active || !this.state.ready || !this.coverage || ![
			e.x,
			e.y,
			t
		].every(Number.isFinite) || t < 0) return;
		let n = [
			[-t, -t],
			[t, -t],
			[t, t],
			[-t, t]
		].map(([t, n]) => this.unproject({
			x: e.x + t,
			y: e.y + n
		})), r = n.map((e) => e[0] + 360 * Math.round((105 - e[0]) / 360)), i = [
			Math.min(...r),
			Math.min(...n.map((e) => e[1])),
			Math.max(...r),
			Math.max(...n.map((e) => e[1]))
		], a = this.unproject(e), o = this.coverage.area, s = {
			point: e,
			bounds: i,
			zoom: this.camera.zoom,
			tolerance: t,
			project: (e, t) => {
				let n = g(this.camera, this.size, [e, t], { wrapLongitude: !1 });
				return {
					x: n.x,
					y: this.size.height / 2 + (n.y - this.size.height / 2) * Math.cos(this.pitch * Math.PI / 180)
				};
			},
			unproject: (e) => this.unproject(e),
			insideCoverage: (e, t) => M(e, t, o),
			pointerInsideCoverage: M(a[0], a[1], o)
		}, c = this.routeHit && gn([this.routeHit], s);
		return c ? c.id : this.paths ? gn(this.trailOverlayPaintedEntries, {
			...s,
			skipId: this.routeId
		})?.id : void 0;
	}
	setTrailOverlay(e) {
		e.length === this.trailOverlay.length && e.every((e, t) => {
			let n = this.trailOverlay[t];
			return e.key === n.key && e.parts === n.parts && e.detail === n.detail && e.coastal === n.coastal && e.ids.length === n.ids.length && e.ids.every((e, t) => e === n.ids[t]);
		}) || (this.trailOverlay = e, this.trailOverlayWindow = void 0, this.trailRaster?.clear(), this.trailOverlayPaintedEntries = [], this.trailOverlayViewportReady = !e.length, this.schedule());
	}
	prepareTrailOverlay() {
		if (!this.trailOverlay.length) {
			this.trailOverlayBatch = void 0, this.trailRasterParts = void 0, this.trailRaster?.clear(), this.reviewedCoastalOverlayBatch = void 0, this.reviewedCoastalOverlaySources = 0, this.trailOverlayCandidateCounts = {
				sources: 0,
				parts: 0,
				details: 0
			};
			return;
		}
		let e = this.getBounds(), t = this.camera.zoom <= K[0] ? 0 : this.camera.zoom <= K[1] ? 1 : 2, n = this.trailOverlayWindow;
		if (n && this.trailOverlayLevel === t && e[0] >= n[0] && e[1] >= n[1] && e[2] <= n[2] && e[3] <= n[3]) return;
		let r = this.virtualSize(), i = w(this.camera, {
			width: r.width + 512,
			height: r.height + 512
		}), a = new Path2D(), o = [], s = 0, c = 0, l = 0, u = 0, f = 0;
		for (let e of this.trailOverlay) {
			if (this.routeId && e.ids.includes(this.routeId)) continue;
			if (G(e.coastal) && e.key === e.coastal.key) {
				let t = this.reviewedCoastalPaths.get(e.coastal);
				t || (t = Q(e.coastal.geometry), this.reviewedCoastalPaths.set(e.coastal, t)), Y(t.bounds, i) && (a.addPath(t.path), s++, l++, c += e.coastal.geometry.coordinates.length, u++);
				continue;
			}
			let n = t === 2 && e.detail !== void 0, r = n ? e.detail : e.parts, d = !1;
			for (let e of r) {
				if (!Y(e.bounds, i)) continue;
				let n = mn(e, t);
				o.push(n), f += 16 + n.length, c++, d = !0;
			}
			d && (s++, n && l++);
		}
		if (this.trailOverlayBatch = void 0, this.trailRasterParts = void 0, f > Nn) this.trailRasterParts = o.map((e) => {
			let t = this.trailRasterPartCache.get(e);
			if (t) return t;
			let n = new Float64Array(e.length * 2), r = 105;
			for (let t = 0; t < e.length; t++) {
				let i = e[t], a = i[0] + 360 * Math.round((r - i[0]) / 360);
				r = a;
				let o = d([a, i[1]]);
				n[t * 2] = o.x, n[t * 2 + 1] = o.y;
			}
			return t = {
				id: ++this.trailRasterPartSerial,
				points: n
			}, this.trailRasterPartCache.set(e, t), t;
		});
		else if (this.trailRaster?.clear(), o.length) {
			let e = new Path2D();
			for (let t of o) {
				let n = this.trailOverlayPaths.get(t);
				n || (n = Q({
					type: "LineString",
					coordinates: t
				}).path, this.trailOverlayPaths.set(t, n)), e.addPath(n);
			}
			this.trailOverlayBatch = e;
		}
		this.trailOverlayWindow = [...i], this.trailOverlayLevel = t, this.trailOverlayCandidateCounts = {
			sources: s,
			parts: c,
			details: l
		}, this.reviewedCoastalOverlayBatch = u ? a : void 0, this.reviewedCoastalOverlaySources = u;
	}
	updateTrailRasterError() {
		let e = this.trailRaster?.getState().error || "";
		e !== this.trailRasterError && (this.trailRasterError = e, this.options.onOverlayError?.(e ? "Тропы не появились на карте. Повторите загрузку." : ""));
	}
	drawTrailOverlay(e, t) {
		this.prepareTrailOverlay();
		let n = this.context, r = this.camera.zoom < 8 ? 1.4 : 2, i = t ? "rgba(30,48,37,.9)" : "rgba(255,254,245,.9)", a = t ? "#f2d49b" : "#618253", o = !0;
		if (this.trailRasterParts?.length) {
			this.trailRaster ??= new Mn({
				softwareRaster: this.rasterPolicy.softwareRaster,
				onChange: () => {
					this.disposed || (this.updateTrailRasterError(), this.schedule());
				}
			});
			let { a: t, b: s, c, d: l, e: u, f: d } = n.getTransform(), f = this.trailRaster.request({
				parts: this.trailRasterParts,
				width: this.canvas.width,
				height: this.canvas.height,
				transform: [
					t,
					s,
					c,
					l,
					u,
					d
				],
				haloWidth: (r + 2) / e,
				lineWidth: r / e,
				haloColor: i,
				lineColor: a
			});
			o = !!f, f && (n.save(), n.setTransform(1, 0, 0, 1, 0, 0), n.drawImage(f.bitmap, 0, 0), n.restore());
		} else this.trailOverlayBatch && (n.lineCap = "round", n.lineJoin = "round", n.strokeStyle = i, n.lineWidth = (r + 2) / e, n.stroke(this.trailOverlayBatch), n.strokeStyle = a, n.lineWidth = r / e, n.stroke(this.trailOverlayBatch));
		this.updateTrailRasterError(), this.trailOverlayViewportReady = o, this.trailOverlayPaintedEntries = o ? this.trailOverlay : this.trailOverlay.filter((e) => G(e.coastal) && e.key === e.coastal.key);
		let s = this.trailOverlayCandidateCounts;
		this.trailOverlaySources = o ? s.sources : this.reviewedCoastalOverlaySources, this.trailOverlayParts = o ? s.parts : this.trailOverlayPaintedEntries.reduce((e, t) => e + (t.coastal?.geometry.coordinates.length ?? 0), 0), this.trailOverlayDetails = o ? s.details : this.reviewedCoastalOverlaySources;
	}
	setMarkers(e) {
		let t = new Set(e.map((e) => e.id));
		for (let [e, n] of this.markers) t.has(e) || (n.button.remove(), this.markers.delete(e));
		for (let t of e) {
			let e = this.markers.get(t.id);
			if (e && e.marker.kind !== t.kind && (e.button.remove(), this.markers.delete(t.id), e = void 0), !e) {
				let n = t.kind === "direction" ? pt({
					id: t.id,
					name: t.label
				}) : document.createElement("button");
				if (n.type = "button", n.dataset.mapMarkerId = t.id, t.kind !== "direction" && (n.className = `tropnik-point-marker tropnik-point-marker--${t.kind}`, n.style.transition = "none"), n.addEventListener("pointerdown", (e) => {
					e.button === 0 && this.active && this.markers.get(t.id)?.button === n && (this.markerPointer = {
						button: n,
						id: e.pointerId
					});
				}), n.addEventListener("click", (e) => {
					let r = this.markerPointer;
					if (this.markerPointer = void 0, !this.active || this.markers.get(t.id)?.button !== n) return;
					let i = e.pointerId;
					if (e.detail !== 0 && (r?.button !== n || typeof i == "number" && i !== r.id)) return;
					let a = this.markerGroups.get(t.id);
					if (a && a.members.length > 1) {
						this.options.onGesture?.();
						let e = C(a.bounds, this.size, {
							padding: this.padding,
							maxZoom: 11,
							referenceLongitude: 105
						});
						this.setCamera({
							...e,
							zoom: Math.max(this.camera.zoom + 1, e.zoom)
						}, !0);
					} else this.options.onMarker?.(t.id);
				}), t.kind !== "direction") for (let e of ["focus", "blur"]) n.addEventListener(e, () => this.schedule(!1));
				this.markerLayer.appendChild(n), e = {
					marker: t,
					button: n
				}, this.markers.set(t.id, e);
			}
			e.marker = t, t.kind !== "direction" && (e.button.setAttribute("aria-label", t.kind === "trail" ? `Открыть маршрут ${t.label}` : t.label), e.button.dataset.trailId = t.kind === "trail" ? t.id : "", e.button.classList.toggle("is-selected", !!t.active), e.button.textContent = t.kind === "plan" ? t.label.slice(0, 2) : "");
		}
		this.markerPointer && !this.markerLayer.contains(this.markerPointer.button) && (this.markerPointer = void 0), this.schedule(!1);
	}
	setPosition(e) {
		let t = [...this.markers.values()].map((e) => e.marker).filter((e) => e.id !== "current-position");
		e && t.push({
			id: "current-position",
			coordinate: e,
			label: "Моё местоположение",
			kind: "position"
		}), this.setMarkers(t);
	}
	coveragePath(e) {
		if (!e) return new Path2D();
		if (e.type === "Feature") return this.coveragePath(e.geometry ?? void 0);
		if (e.type === "FeatureCollection" || e.type === "GeometryCollection") {
			let t = e.type === "FeatureCollection" ? e.features : e.geometries;
			if (t.length === 1) return this.coveragePath(t[0]);
			let n = new Path2D();
			for (let e of t) n.addPath(this.coveragePath(e));
			return n;
		}
		let t = this.coveragePaths.get(e);
		return t || (t = Q(e).path, this.coveragePaths.set(e, t)), t;
	}
	selectedCoveragePath(e) {
		let t = e?.features.filter((e) => this.selectedShapes.includes(String(e.properties?.shapeName))) || [];
		return t.length ? this.coveragePath({
			type: "FeatureCollection",
			features: t
		}) : void 0;
	}
	updateSelectedArea() {
		let e = this.selectedCoveragePath(this.coverage?.territories), t = this.selectedCoveragePath(this.coverage?.boundaries);
		this.selectedArea = e, this.selectedBoundary = t;
	}
	applyCoverage() {
		if (!this.coverage) return;
		let e = this.coverage.status, t = e.revision !== this.coverageRevision;
		if (t) {
			let t = this.coveragePath(this.coverage.area), n = this.coveragePath(this.coverage.boundaries), r = this.selectedCoveragePath(this.coverage.territories), i = this.selectedCoveragePath(this.coverage.boundaries), a = new Path2D();
			a.rect(-3, -3, 8, 8), a.addPath(t), this.area = t, this.boundaries = n, this.mask = a, this.selectedArea = r, this.selectedBoundary = i, this.coverageRevision = e.revision;
		}
		this.element.dataset.mapCoverage = JSON.stringify(e), this.element.dataset.mapCoverageLod = e.lod, this.element.dataset.mapCoverageState = e.ready ? "ready" : "loading", t ? (this.state.ready && !this.state.loading && [
			this.detail,
			this.relief,
			this.imagery,
			this.imageryOverlay
		].some((e) => !this.batchCoversMask(e)) && (this.currentKeys = "", this.refreshTiles()), this.schedule()) : this.publishInspection();
	}
	listen(e, t, n, r) {
		e.addEventListener(t, n, r), this.listeners.push([
			e,
			t,
			n,
			r
		]);
	}
	bindInput() {
		let e = () => {
			this.markerPointer = void 0;
		};
		this.listen(document, "pointerdown", e, !0), this.listen(document, "pointercancel", e, !0), this.listen(this.element, Yt, ((e) => {
			let t = e.detail;
			!t || typeof t != "object" || (t.response = JSON.stringify(this.inspectLabels(t.request)));
		}));
		let t = (e) => {
			let t = this.pointerRect ?? this.canvas.getBoundingClientRect();
			return {
				x: e.clientX - t.left,
				y: e.clientY - t.top
			};
		};
		this.listen(this.canvas, "pointerdown", ((e) => {
			if (e.button !== 0 || !this.state.ready || !this.active) return;
			e.preventDefault(), this.canvas.focus({ preventScroll: !0 }), this.stopAnimation(), clearTimeout(this.settleTimer), this.options.onGesture?.(), this.pointerRect = this.canvas.getBoundingClientRect();
			let n = t(e);
			this.pointer.begin(e.pointerId, this.flatPoint(n), this.camera, this.size), this.setMoving(!0), this.pointer.activePointers === 1 ? (this.pointerStart = {
				...n,
				time: performance.now(),
				id: e.pointerId
			}, this.pointerMoved = !1) : this.pointerMoved = !0, this.canvas.setPointerCapture(e.pointerId), this.canvas.classList.add("is-moving");
		})), this.listen(this.canvas, "pointermove", ((e) => {
			if (!this.pointer.activePointers) return;
			let n = t(e), r = this.pointer.move(e.pointerId, this.flatPoint(n));
			if (!r) return;
			this.pointerStart && Math.hypot(n.x - this.pointerStart.x, n.y - this.pointerStart.y) > 5 && (this.pointerMoved = !0);
			let i = z(r.center[0], r.center[1], r.zoom, {
				...this.floor,
				center: [...this.floor.center]
			}, this.framed ? {
				...this.framed,
				center: [...this.framed.center]
			} : null);
			this.camera = {
				...r,
				center: i.center,
				zoom: i.zoom
			}, this.schedule();
		}));
		let n = ((e) => {
			let n = this.pointerStart, r = t(e), i = e.type === "pointerup" && !this.pointerMoved && n?.id === e.pointerId && performance.now() - n.time < 700;
			this.pointer.end(e.pointerId), this.canvas.hasPointerCapture(e.pointerId) && this.canvas.releasePointerCapture(e.pointerId), this.pointer.activePointers || (this.pointerRect = void 0, this.pointerStart = void 0, this.canvas.classList.remove("is-moving"), this.settled()), i && this.options.onClick?.(r, this.unproject(r));
		});
		this.listen(this.canvas, "pointerup", n), this.listen(this.canvas, "pointercancel", n), this.listen(this.canvas, "lostpointercapture", ((e) => {
			let t = this.pointer.activePointers;
			this.pointer.end(e.pointerId), t && !this.pointer.activePointers && (this.pointerRect = void 0, this.pointerStart = void 0, this.canvas.classList.remove("is-moving"), this.settled());
		})), this.listen(this.canvas, "wheel", ((e) => {
			if (!this.state.ready || !this.active) return;
			e.preventDefault(), this.options.onGesture?.(), this.stopAnimation();
			let n = S(this.camera, this.size, this.camera.zoom + se(e.deltaY, e.deltaMode, this.size.height), this.flatPoint(t(e)), {
				minZoom: this.floor.zoom,
				maxZoom: this.options.maxZoom ?? 18
			}), r = z(n.center[0], n.center[1], n.zoom, {
				...this.floor,
				center: [...this.floor.center]
			}, this.framed ? {
				...this.framed,
				center: [...this.framed.center]
			} : null);
			this.camera = {
				...n,
				center: r.center,
				zoom: r.zoom
			}, this.setMoving(!0), this.schedule(), clearTimeout(this.settleTimer), this.settleTimer = setTimeout(() => this.settled(), 110);
		}), { passive: !1 }), this.listen(this.canvas, "dblclick", ((e) => {
			if (!this.state.ready || !this.active) return;
			e.preventDefault();
			let t = this.canvas.getBoundingClientRect();
			this.options.onGesture?.(), this.setCamera(S(this.camera, this.size, this.camera.zoom + 1, this.flatPoint({
				x: e.clientX - t.left,
				y: e.clientY - t.top
			}), {
				minZoom: this.floor.zoom,
				maxZoom: this.options.maxZoom ?? 18
			}), !0);
		})), this.listen(this.canvas, "keydown", ((e) => {
			if (e.altKey || e.ctrlKey || e.metaKey || !this.state.ready || !this.active) return;
			if ([
				"+",
				"=",
				"Add",
				"PageUp",
				"-",
				"−",
				"Subtract",
				"PageDown"
			].includes(e.key)) {
				e.preventDefault(), this.zoomBy([
					"+",
					"=",
					"Add",
					"PageUp"
				].includes(e.key) ? 1 : -1);
				return;
			}
			let t = ce(this.camera, this.size, e.key, {
				minZoom: this.floor.zoom,
				maxZoom: this.options.maxZoom ?? 18
			});
			t ? (e.preventDefault(), this.options.onGesture?.(), this.setCamera(t, !0)) : e.key === "Home" && (e.preventDefault(), this.options.onGesture?.(), this.setCamera(this.floor, !0));
		})), this.listen(window, "blur", () => {
			this.markerPointer = void 0, this.pointer.cancel(), this.canvas.classList.remove("is-moving"), this.settled();
		}), this.listen(window, "online", () => {
			this.coverageTask || this.state.loading ? this.retryAfterCurrent = !0 : this.retry();
		}), this.listen(window, "offline", () => {
			this.currentKeys = "", this.updateState({ error: "Нет сети. Доступны сохранённые границы, маршруты и загруженные участки карты." }), this.refreshTiles();
		});
	}
	resizeCanvas() {
		if (this.disposed) return;
		let e = Math.max(1, this.element.clientWidth), t = Math.max(1, this.element.clientHeight);
		if (!(e === this.size.width && t === this.size.height && this.canvas.width > 1)) {
			(e !== this.size.width || t !== this.size.height) && this.stopAnimation(), this.pointer.cancel(), this.size = {
				width: e,
				height: t
			}, this.pixelRatio = this.eco ? 1 : Math.min(devicePixelRatio || 1, matchMedia("(pointer:coarse)").matches ? 1.5 : 2), this.canvas.width = Math.round(e * this.pixelRatio), this.canvas.height = Math.round(t * this.pixelRatio), this.labelCanvas.width = this.canvas.width, this.labelCanvas.height = this.canvas.height;
			for (let n of [this.canvas, this.labelCanvas]) n.style.width = `${e}px`, n.style.height = `${t}px`;
			this.currentKeys = "", this.schedule(), this.state.ready && this.settled();
		}
	}
	updateState(e) {
		this.disposed || (this.state = {
			...this.state,
			...e,
			residentTiles: this.tiles.resident,
			pendingTiles: this.tiles.pending
		}, this.publishInspection(), this.options.onState?.({ ...this.state }));
	}
	schedule(e = !0) {
		this.paintRequested ||= e, !this.frame && !this.disposed && this.active && (this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			let e = this.paintRequested, t = this.labelsRequested;
			if (this.paintRequested = !1, this.labelsRequested = !1, e) this.draw();
			else {
				let e = this.drawMarkers();
				(t || e) && (this.drawLabels(), this.publishInspection());
			}
		}));
	}
	scheduleLabels() {
		this.labelsRequested = !0, this.schedule(!1);
	}
	settled() {
		if (this.disposed || !this.active) return;
		this.setMoving(!1), ft(this.element, {
			longitude: this.camera.center[0],
			latitude: this.camera.center[1],
			zoom: this.camera.zoom,
			tileSize: 256,
			engine: "tropnik-canvas",
			centerX: this.size.width / 2,
			centerY: this.size.height / 2
		}), this.element.dataset.mapBearing = String(this.camera.bearingDegrees ?? 0), this.options.onSettled?.(this.getCamera());
		let e = this.getBounds();
		requestAnimationFrame(() => {
			this.disposed || (Ot(new Map([...this.markers].filter(([, e]) => e.marker.kind === "direction").map(([e, t]) => [e, t.button])), this.element), lt(this.routeEdges));
		}), this.coverage?.updateView([...e], this.camera.zoom).catch(() => void 0), this.refreshTiles(), this.schedule();
	}
	refreshTiles() {
		if (this.disposed || !this.active || !this.coverage) return;
		let e = this.virtualSize(), t = Math.max(0, Math.floor(this.camera.zoom)), n = $(this.camera, e, Math.min(4, t), "overview"), r = Math.min(18, Math.ceil(this.camera.zoom)), i = this.mode !== "overview" && t >= 5 ? $(this.camera, e, r, "vector", this.paths, this.mode === "satellite", this.boundaryVisible) : [], a = this.mode === "detail" && this.reliefVisible && t >= 5 ? $(this.camera, e, r, "relief") : [], o = this.getBounds(), s = Xe({
			west: o[0],
			south: o[1],
			east: o[2],
			north: o[3]
		}), c = this.mode === "satellite" ? $(this.camera, e, Math.min(s === "eox-s2" ? 14 : 8, t), s) : [], l = [
			...n,
			...i,
			...a,
			...c
		], u = l.map(R).join("|");
		if (u === this.currentKeys) return;
		this.currentKeys = u;
		let d = ++this.generation, f = () => [
			this.overview,
			this.detail,
			this.relief,
			this.imagery,
			this.imageryOverlay
		].flatMap((e) => e?.tiles.map((e) => e.key) || []);
		this.tiles.pin([...l.map(R), ...f()]), this.updateState({
			loading: l.length > 0,
			imageryLoading: c.length > 0,
			imageryTarget: c.length ? s : void 0
		});
		let p = () => !this.disposed && d === this.generation, m = this.coverageRevision, h = async (e, t) => {
			let n = await Promise.allSettled(e.map((e) => this.tiles.load(e))), r = n.flatMap((e) => e.status === "fulfilled" ? [e.value] : []), i = n.length - r.length, a = e.filter((e, t) => n[t].status === "rejected");
			return {
				value: {
					tiles: r,
					kind: t,
					generation: d,
					missing: a
				},
				failed: i
			};
		}, g = h(n, "overview").then((e) => {
			if (p() && (e.value.tiles.length && (!e.failed || !this.overview) && (this.overview = e.value, this.schedule()), !i.length && !c.length)) {
				if (e.failed) {
					this.updateState({ error: "Обзор карты загрузился не полностью. Повторите загрузку." });
					return;
				}
				this.detail = void 0, this.relief = void 0, this.imagery = void 0, this.imageryOverlay = void 0, this.updateState({
					committedMode: "overview",
					reliefReady: !1,
					localDetail: !1,
					imagerySource: void 0,
					...navigator.onLine ? { error: "" } : {}
				}), this.schedule();
			}
		}), _ = Promise.all([
			h(i, "vector"),
			h(a, "relief"),
			h(c, s)
		]).then(([e, t, n]) => {
			if (!p() || !i.length && !c.length) return;
			m = this.coverageRevision;
			let r = !this.batchCoversMask(e.value), o = !this.batchCoversMask(t.value);
			if (!this.batchCoversMask(n.value) || !c.length && (r || o)) {
				this.updateState({
					imageryLoading: !1,
					error: c.length ? "Спутниковая карта загрузилась не полностью. Повторите загрузку." : "Подробная карта загрузилась не полностью. Повторите загрузку."
				});
				return;
			}
			if (c.length) {
				this.imagery = n.value, r || (this.imageryOverlay = e.value), this.detail = void 0, this.relief = void 0;
				let t = this.imageryOverlay;
				this.updateState({
					committedMode: "satellite",
					imageryLoading: !1,
					imagerySource: s,
					reliefReady: !1,
					localDetail: !!t?.tiles.length && t.tiles.every((e) => e.local),
					...r ? { error: "Подписи и тропы на спутниковой карте загрузились не полностью. Повторите загрузку." } : navigator.onLine ? { error: "" } : {}
				});
			} else this.detail = e.value, this.relief = a.length ? t.value : void 0, this.imagery = void 0, this.imageryOverlay = void 0, this.updateState({
				committedMode: "detail",
				imagerySource: void 0,
				imageryTarget: void 0,
				reliefReady: t.value.tiles.length > 0,
				localDetail: e.value.tiles.length > 0 && e.value.tiles.every((e) => e.local),
				...navigator.onLine ? { error: "" } : {}
			});
			this.schedule();
		});
		Promise.all([g, _]).finally(() => {
			p() && (this.tiles.pin([...l.map(R), ...f()]), this.updateState({ loading: !1 }), m !== this.coverageRevision && [
				this.detail,
				this.relief,
				this.imagery,
				this.imageryOverlay
			].some((e) => !this.batchCoversMask(e)) && this.retry(), this.retryAfterOnline());
		});
	}
	batchCoversMask(e) {
		return !e?.missing?.some((e) => kn(this.coverage?.area, e, this.camera.zoom, this.pitch));
	}
	displayingSatellite() {
		return this.state.committedMode === "satellite" && !!this.imagery;
	}
	displayDetail() {
		return this.displayingSatellite() ? this.imageryOverlay : this.detail;
	}
	worldTransform() {
		let e = this.context, t = 256 * 2 ** this.camera.zoom, n = d(this.camera.center), r = (this.camera.bearingDegrees ?? 0) * Math.PI / 180;
		return e.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0), e.translate(this.size.width / 2, this.size.height / 2), e.scale(1, Math.cos(this.pitch * Math.PI / 180)), e.rotate(-r), e.scale(t, t), e.translate(-n.x, -n.y), t;
	}
	drawTiles(e, t = 1) {
		if (!e) return;
		let n = this.context;
		n.globalAlpha = t;
		for (let t of e.tiles) {
			let e = 2 ** t.z;
			n.drawImage(t.bitmap, t.x / e, t.y / e, 1 / e + 1e-10, 1 / e + 1e-10);
		}
		n.globalAlpha = 1;
	}
	detailCoversViewport(e) {
		if (this.mode !== "detail" || this.pitch !== 0 || (this.camera.bearingDegrees ?? 0) !== 0 || this.camera.zoom < 4.7 || this.camera.zoom > 12 || e?.kind !== "vector" || !e.tiles.length || e.tiles.length > Z) return !1;
		let t = this.pixelRatio, n = this.canvas.width, r = this.canvas.height, i = 256 * 2 ** this.camera.zoom, a = d(this.camera.center), o = e.tiles[0].z;
		if (![
			t,
			n,
			r,
			this.size.width,
			this.size.height,
			i,
			a.x,
			a.y
		].every(Number.isFinite) || t <= 0 || t > 2 || n <= 0 || r <= 0 || n > 32768 || r > 32768 || this.size.width <= 0 || this.size.height <= 0 || Math.abs(a.x) > 2 || a.y < 0 || a.y > 1 || !Number.isInteger(o) || o < 0 || o > 18) return !1;
		let s = 2 ** o;
		if (i * t / s <= 1) return !1;
		let c = (a.x + (-4 / t - this.size.width / 2) / i) * s, l = (a.x + ((n + 4) / t - this.size.width / 2) / i) * s, u = (a.y + (-4 / t - this.size.height / 2) / i) * s, f = (a.y + ((r + 4) / t - this.size.height / 2) / i) * s, p = Math.floor(c), m = Math.floor(l), h = Math.floor(u), g = Math.floor(f);
		if (![
			p,
			m,
			h,
			g
		].every(Number.isSafeInteger) || m < p || g < h || h < 0 || g >= s || (m - p + 1) * (g - h + 1) > Z) return !1;
		let _ = /* @__PURE__ */ new Set();
		for (let t of e.tiles) {
			if (t.kind !== "vector" || t.transparent !== !1 || t.z !== o || !Number.isSafeInteger(t.x) || !Number.isInteger(t.y) || t.y < 0 || t.y >= s || t.bitmap.width !== 512 || t.bitmap.height !== 512) return !1;
			_.add(`${t.x}/${t.y}`);
		}
		for (let e = h; e <= g; e++) for (let t = p; t <= m; t++) if (!_.has(`${t}/${e}`)) return !1;
		return !0;
	}
	groundSignature(e, t, n) {
		let r = this.context;
		return [
			this.canvas.width,
			this.canvas.height,
			this.size.width,
			this.size.height,
			this.pixelRatio,
			...this.camera.center,
			this.camera.zoom,
			this.camera.bearingDegrees ?? 0,
			this.pitch,
			this.mode,
			this.state.committedMode,
			t,
			n,
			this.area,
			this.overview,
			e,
			this.imagery,
			this.relief,
			this.boundaries,
			this.boundaryVisible,
			this.reliefVisible,
			this.selectedArea,
			this.selectedBoundary,
			r.lineCap,
			r.lineJoin,
			r.miterLimit
		];
	}
	restoreGround(e) {
		let t = this.groundSnapshot;
		if (!t || t.signature.length !== e.length || e.some((e, n) => !Object.is(e, t.signature[n]))) return !1;
		let n = this.context;
		return n.save(), n.setTransform(1, 0, 0, 1, 0, 0), n.globalAlpha = 1, n.globalCompositeOperation = "copy", n.drawImage(t.surface, 0, 0), n.restore(), !0;
	}
	retainGround(e) {
		if (!(this.pointer.activePointers || this.animation || this.groundSnapshotUnavailable) && !((this.camera.bearingDegrees ?? 0) !== 0 || this.pitch !== 0)) {
			if (this.canvas.width * this.canvas.height * 4 > Pn) {
				this.releaseGround();
				return;
			}
			if (!(typeof OffscreenCanvas > "u")) try {
				let t = this.groundSnapshot;
				if (!t) {
					let e = new OffscreenCanvas(this.canvas.width, this.canvas.height), n = e.getContext("2d", {
						alpha: !1,
						willReadFrequently: this.rasterPolicy.softwareRaster
					});
					if (!n) {
						this.groundSnapshotUnavailable = !0;
						return;
					}
					t = {
						surface: e,
						context: n,
						signature: []
					}, this.groundSnapshot = t;
				}
				t.surface.width !== this.canvas.width && (t.surface.width = this.canvas.width), t.surface.height !== this.canvas.height && (t.surface.height = this.canvas.height);
				let n = t.context;
				n.setTransform(1, 0, 0, 1, 0, 0), n.globalAlpha = 1, n.globalCompositeOperation = "copy", n.drawImage(this.canvas, 0, 0), t.signature = e;
			} catch {
				this.releaseGround(), this.groundSnapshotUnavailable = !0;
			}
		}
	}
	releaseGround() {
		let e = this.groundSnapshot;
		this.groundSnapshot = void 0, e && (e.surface.width = 0, e.surface.height = 0);
	}
	draw() {
		if (this.disposed || !this.active) return;
		let e = this.context, t = this.displayDetail(), n = this.detailCoversViewport(t), r = this.displayingSatellite(), i = this.groundSignature(t, r, n), a;
		if (this.restoreGround(i) ? a = this.worldTransform() : (e.setTransform(1, 0, 0, 1, 0, 0), n || (e.fillStyle = ye, e.fillRect(0, 0, this.canvas.width, this.canvas.height)), a = this.worldTransform(), n || (this.area && (e.fillStyle = "#dce5cf", e.fill(this.area, "evenodd")), this.drawTiles(this.overview, .95)), r && this.drawTiles(this.imagery), this.mode !== "overview" && this.camera.zoom >= 4.7 && (!r || t?.tiles[0]?.transparent) && this.drawTiles(t), !r && (this.mode === "detail" || this.state.committedMode === "detail") && this.reliefVisible && this.camera.zoom >= 4.7 && this.drawTiles(this.relief, .82), this.boundaryVisible && this.boundaries && (e.strokeStyle = r ? "rgba(245,248,232,.45)" : "rgba(95,123,87,.45)", e.lineWidth = .65 / a, e.stroke(this.boundaries)), this.selectedArea && (e.fillStyle = "rgba(92,128,70,.10)", e.fill(this.selectedArea, "evenodd")), this.selectedBoundary && (e.strokeStyle = r ? "#e7eacc" : "#688360", e.lineWidth = 1.3 / a, e.stroke(this.selectedBoundary)), this.retainGround(i)), this.paths && this.drawTrailOverlay(a, r), this.route && !this.reviewedCoastalRoute && (e.lineCap = "round", e.lineJoin = "round", e.strokeStyle = "#fffef5", e.lineWidth = (B(this.camera.zoom) + 3) / a, e.stroke(this.route.path), e.strokeStyle = "#244d3c", e.lineWidth = B(this.camera.zoom) / a, e.stroke(this.route.path)), this.mask && (e.fillStyle = ye, e.fill(this.mask, "evenodd")), this.paths && this.reviewedCoastalOverlayBatch) {
			let t = this.camera.zoom < 8 ? 1.4 : 2;
			e.lineCap = "round", e.lineJoin = "round", e.strokeStyle = r ? "rgba(30,48,37,.9)" : "rgba(255,254,245,.9)", e.lineWidth = (t + 2) / a, e.stroke(this.reviewedCoastalOverlayBatch), e.strokeStyle = r ? "#f2d49b" : "#618253", e.lineWidth = t / a, e.stroke(this.reviewedCoastalOverlayBatch);
		}
		if (this.reviewedCoastalRoute || this.paths && this.reviewedCoastalOverlayBatch && this.route && this.area) {
			let t = this.reviewedCoastalRoute ?? this.route;
			e.save(), this.reviewedCoastalRoute || e.clip(this.area, "evenodd"), e.lineCap = "round", e.lineJoin = "round", e.strokeStyle = "#fffef5", e.lineWidth = (B(this.camera.zoom) + 3) / a, e.stroke(t.path), e.strokeStyle = "#244d3c", e.lineWidth = B(this.camera.zoom) / a, e.stroke(t.path), e.restore();
		}
		this.drawMarkers(), this.drawLabels(), this.element.dataset.mapPainted = "true", this.element.dataset.mapCanvas = "custom", this.element.dataset.mapDrawnRoute = this.routeId || "", this.drawRevision++, !this.pointer.activePointers && !this.animation && this.publishInspection(), this.options.onFrame?.(this.getCamera());
	}
	drawMarkers() {
		let e = [], t = [...this.markers.values()].filter((e) => e.marker.kind === "direction"), n = Mt(t.map(({ marker: e }) => ({
			id: e.id,
			name: e.label,
			center: e.coordinate
		})), (e) => this.project(e), new Set([...this.markerGroups.values()].map((e) => e.key)));
		this.markerGroups = Pt(new Map(t.map((e) => [e.marker.id, e.button])), n, new Map(t.map((e) => [e.marker.id, e.marker.count || 0])), this.camera.zoom < 5, t.find((e) => e.marker.active)?.marker.id);
		for (let { marker: t, button: n } of this.markers.values()) {
			let r = this.project(t.coordinate), i = !Number.isFinite(r.x) || !Number.isFinite(r.y) || r.x < -22 || r.x > this.size.width + 22 || r.y < -22 || r.y > this.size.height + 22;
			t.kind === "direction" ? i && (n.hidden = !0) : n.hidden = i, n.style.transform = `translate(${r.x - 22}px,${r.y - 22}px)`, t.kind !== "direction" && !n.hidden && e.push(An(r, t.kind, !!t.active, n.matches(":focus-visible")));
		}
		for (let e of this.routeEdges) {
			let t = e.project();
			e.element.style.position = "absolute", e.element.style.left = `${t.x}px`, e.element.style.top = `${t.y}px`;
		}
		let r = e.length !== this.markerObstacles.length || e.some((e, t) => {
			let n = this.markerObstacles[t];
			return !n || e.left !== n.left || e.top !== n.top || e.right !== n.right || e.bottom !== n.bottom;
		});
		return this.markerObstacles = e, r;
	}
	prepareLabelCandidates(e) {
		let t = this.mode !== "overview" && this.camera.zoom >= 5, n = t ? this.displayDetail() : void 0, r = t && !this.displayingSatellite() && (this.mode === "detail" || this.state.committedMode === "detail") && this.reliefVisible && this.camera.zoom >= 10 ? this.relief : void 0, i = this.labelCandidateCache;
		if (i && i.detail === n && i.relief === r && i.additional === this.additionalLabels && i.area === e) return i.candidates;
		let a = (e, t, n, r) => ({
			id: e,
			coordinate: t,
			label: n,
			color: r,
			priority: Bt(n),
			sourceAnchor: `${n.kind}:${n.symbol || ""}:${n.text}:${t[0].toFixed(6)},${t[1].toFixed(6)}`
		}), o = this.additionalLabels.map((e) => a(e.id, e.coordinate, {
			x: 0,
			y: 0,
			text: e.label,
			kind: e.kind ?? "place",
			rank: e.rank ?? 0
		}, e.color));
		for (let e of [n, r]) if (e) for (let t of e.tiles) for (let e of t.labels) {
			let n = 2 ** t.z;
			o.push(a(`${t.key}:${e.text}`, f({
				x: (t.x + e.x) / n,
				y: (t.y + e.y) / n
			}), e));
		}
		return o.sort((e, t) => e.priority - t.priority || e.label.rank - t.label.rank), this.labelCandidateCache = {
			detail: n,
			relief: r,
			additional: this.additionalLabels,
			area: e,
			candidates: o
		}, o;
	}
	drawLabels() {
		this.labelDiagnostics = [], this.labelDiagnosticTotal = 0;
		let e = this.labelContext;
		if (e.setTransform(1, 0, 0, 1, 0, 0), e.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height), e.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0), this.labelRevision++, !this.coverage) {
			this.labelCanvas.hidden = !0;
			return;
		}
		let t = [...this.obstacles, ...this.markerObstacles], n = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Map(), i = this.prepareLabelCandidates(this.coverage.area);
		this.labelDiagnosticTotal = i.length;
		let a = 0, o = Vt(this.size.width, this.size.height);
		for (let s of i) {
			let { id: i, coordinate: c, label: l, color: u, sourceAnchor: d } = s, f = {
				id: i,
				label: l.text,
				coordinate: c,
				visible: !1,
				reason: "budget"
			};
			if (this.labelDiagnostics.length < 6400 && this.labelDiagnostics.push(f), a >= o) continue;
			if (n.has(d)) {
				f.reason = "duplicate";
				continue;
			}
			if (!(s.insideCoverage ??= M(c[0], c[1], this.coverage.area))) {
				f.reason = "outside-coverage";
				continue;
			}
			let p = this.project(c), m = zt(l, this.camera.zoom, u);
			if (p.x < 24 || p.x > this.size.width - 24 || p.y < 32 || p.y > this.size.height - 20) {
				f.reason = "outside-viewport";
				continue;
			}
			let h = s.value ??= l.kind === "peak" && l.elevation !== void 0 ? `${l.text ? l.text + " · " : ""}${Math.round(l.elevation)} м` : l.text;
			e.font = `${m.weight} ${m.fontSize}px Manrope, sans-serif`;
			let g = e.measureText(h).width, _ = Wt(l, p, g, !!h, m), { rect: v } = _;
			if (f.x = p.x, f.y = p.y, f.width = g, f.rect = v, v.left < 12 || v.right > this.size.width - 12 || v.top < 12 || v.bottom > this.size.height - 12) {
				f.reason = "outside-viewport";
				continue;
			}
			let y = s.repeatDistance ??= Ht(l), b = s.repeatKey ??= Ut(l);
			if (h && y && (r.get(b) || []).some((e) => Math.hypot(p.x - e.x, p.y - e.y) < y)) {
				f.reason = "repeated-name";
				continue;
			}
			if (t.some((e) => v.left < e.right && v.right > e.left && v.top < e.bottom && v.bottom > e.top)) {
				f.reason = "collision";
				continue;
			}
			if (t.push(v), n.add(d), h && y) {
				let e = r.get(b) || [];
				e.push(p), r.set(b, e);
			}
			l.symbol && Lt(e, l.symbol, p.x, p.y), Gt(e, h, p, _, m), a++, f.visible = !0, f.reason = "drawn";
		}
		this.labelCanvas.hidden = a === 0;
	}
	destroy() {
		this.disposed || (this.disposed = !0, this.markerPointer = void 0, cancelAnimationFrame(this.frame), this.stopAnimation(), clearTimeout(this.settleTimer), this.resize.disconnect(), this.pointer.cancel(), this.listeners.forEach(([e, t, n, r]) => e.removeEventListener(t, n, r)), this.listeners = [], this.unbindCoverage?.(), this.coverage?.dispose(), this.tiles.destroy(), this.canvas.remove(), this.labelCanvas.remove(), this.markerLayer.remove(), this.markers.clear(), this.routeEdges = [], this.coveragePaths = /* @__PURE__ */ new WeakMap(), this.area = void 0, this.mask = void 0, this.boundaries = void 0, this.selectedArea = void 0, this.selectedBoundary = void 0, this.releaseGround(), this.trailRaster?.destroy(), this.trailRaster = void 0, this.trailRasterParts = void 0, this.trailRasterPartCache = /* @__PURE__ */ new WeakMap(), this.trailOverlayPaintedEntries = [], this.trailOverlay = [], this.trailOverlayPaths = /* @__PURE__ */ new WeakMap(), this.trailOverlayBatch = void 0, this.trailOverlayWindow = void 0, this.routeHit = void 0, this.reviewedCoastalRoute = void 0, this.reviewedCoastalPaths = /* @__PURE__ */ new WeakMap(), this.reviewedCoastalOverlayBatch = void 0, this.reviewedCoastalOverlaySources = 0, this.labelDiagnostics = [], this.labelDiagnosticTotal = 0, this.labelCandidateCache = void 0, this.markerObstacles = []);
	}
}, In = Object.freeze({
	version: 1,
	CustomMapEngine: Fn,
	inRussiaCoverage: M
});
typeof window < "u" && Object.defineProperty(window, "TropnikMapAPI", {
	value: In,
	configurable: !1
});
//#endregion
export { M as a, rn as i, Fn as n, O as o, xn as r, In as t };
