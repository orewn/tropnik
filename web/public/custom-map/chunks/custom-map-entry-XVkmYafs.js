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
	}, _ = c(r.bearingDegrees), y = _ * t, b = Math.abs(Math.cos(y)) * (h.x - m.x) + Math.abs(Math.sin(y)) * (m.y - h.y), S = Math.abs(Math.sin(y)) * (h.x - m.x) + Math.abs(Math.cos(y)) * (m.y - h.y), C = Math.min(b > 0 ? a / b : Infinity, S > 0 ? s / S : Infinity), w = r.maxZoom ?? 18, T = v(Number.isFinite(C) ? Math.log2(C / 256) : w, {
		...r,
		maxZoom: w
	});
	return x(g, {
		x: i.left + a / 2,
		y: i.top + s / 2
	}, n, T, _);
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
var T = (e) => ({
	x: (e[0].x + e[1].x) / 2,
	y: (e[0].y + e[1].y) / 2
}), ne = (e) => Math.hypot(e[1].x - e[0].x, e[1].y - e[0].y);
function re(e, n, r, i, o = {}, s = !1) {
	[...r, ...i].forEach(a);
	let l = h(T(r), p(e, n)), u = ne(r), d = ne(i), f = u >= 1 && d >= 1 ? d / u : 1, m = v(e.zoom + Math.log2(f), o), g = s && u >= 1 && d >= 1 ? c((Math.atan2(i[1].y - i[0].y, i[1].x - i[0].x) - Math.atan2(r[1].y - r[0].y, r[1].x - r[0].x)) / t) : 0;
	return x(l, T(i), n, m, (e.bearingDegrees ?? 0) - g);
}
var ie = class {
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
			} else this.current = re(n, r, [i[0].point, i[1].point], [this.contacts.get(i[0].id), this.contacts.get(i[1].id)], this.options, this.options.rotate);
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
function ae(e, t = 0, n = 800, r = 16) {
	if (i(e, "wheel delta"), t === 0) return e;
	let a = t === 1 ? r : t === 2 ? n : NaN;
	if (!Number.isFinite(a) || a <= 0) throw RangeError("Invalid wheel mode or dimensions");
	return e * a;
}
function oe(e, t = 0, n = 800, r = 480) {
	if (!(i(r, "pixels per zoom") > 0)) throw RangeError("Wheel zoom sensitivity must be positive");
	return -ae(e, t, n) / r;
}
function se(e, t, n, r = {}) {
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
	maxWorkers: 3,
	prefetchTiles: 12,
	constrainedPrefetchTiles: 4,
	geolocationTimeoutMs: 15e3,
	geolocationMaximumAgeMs: 1e4
});
var ce = Object.freeze({
	concurrency: 3,
	maxBytes: 24 * 1024 * 1024,
	maxResourceBytes: 8 * 1024 * 1024,
	maxQueued: 72,
	timeoutMs: 15e3
}), le = class {
	constructor(e = {}) {
		this.entries = /* @__PURE__ */ new Map(), this.queue = [], this.active = 0, this.bytes = 0, this.options = {
			...ce,
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
			consumers: 0
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
	invalidate(e) {
		this.entries.get(e)?.settled && this.remove(e);
	}
	async json(e, t = 1) {
		let n = await this.get(e, t), r = this.entries.get(e);
		if (r?.json !== void 0) return r.json;
		try {
			let e = JSON.parse(new TextDecoder().decode(n));
			return r && (r.json = e), e;
		} catch (t) {
			throw this.remove(e), t;
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
			t.controller = n, this.read(e, n).then((n) => {
				if (this.entries.get(e) === t) {
					t.bytes = n.byteLength, t.settled = !0, this.bytes += t.bytes;
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
	async read(e, t) {
		let n = setTimeout(() => t.abort(), this.options.timeoutMs), r;
		try {
			let n = await this.options.fetcher(e, {
				cache: "force-cache",
				credentials: e.startsWith("/") ? "same-origin" : "omit",
				signal: t.signal
			});
			if (!n.ok) throw Error(`Preview resource unavailable (${n.status})`);
			if (Number(n.headers.get("content-length") || 0) > this.options.maxResourceBytes) throw Error("Preview resource exceeds the byte budget");
			if (r = n.body?.getReader(), !r) return /* @__PURE__ */ new ArrayBuffer(0);
			let i = [], a = 0;
			for (;;) {
				let { value: e, done: t } = await r.read();
				if (t) break;
				if (a += e.byteLength, a > this.options.maxResourceBytes) throw Error("Preview resource exceeds the byte budget");
				i.push(e);
			}
			let o = new Uint8Array(a), s = 0;
			for (let e of i) o.set(e, s), s += e.length;
			return o.buffer;
		} finally {
			clearTimeout(n), t.abort(), await r?.cancel().catch(() => {});
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
function ue(e, t = "https://map-preview.local") {
	try {
		if (e.startsWith("//")) return null;
		let n = new URL(t), r = new URL(e, n);
		return r.username || r.password || r.hash || /%2f|%5c|%00/i.test(r.pathname) ? null : r.origin === n.origin && [
			"/data/",
			"/maps/",
			"/terrain/",
			"/offline-map/"
		].some((e) => r.pathname.startsWith(e)) ? r.pathname + r.search : r.protocol === "https:" && !r.port && ["tiles.openfreemap.org", "tiles.mapterhorn.com"].includes(r.hostname) || r.protocol === "https:" && !r.port && r.hostname === "tiles.maps.eox.at" && !r.search && /^\/wmts\/1\.0\.0\/(s2cloudless_3857|bluemarble_3857)\/default\/g\/\d+\/\d+\/\d+\.jpg$/.test(r.pathname) ? r.href : null;
	} catch {
		return null;
	}
}
//#endregion
//#region web/lib/terrain-preparation.ts
function E(e) {
	return e.reason ?? new DOMException("Terrain preview wait cancelled", "AbortError");
}
function de(e, t) {
	return t.aborted ? Promise.reject(E(t)) : new Promise((n, r) => {
		let i = () => {
			t.removeEventListener("abort", i), r(E(t));
		};
		t.addEventListener("abort", i, { once: !0 }), e.then((e) => {
			t.removeEventListener("abort", i), n(e);
		}, (e) => {
			t.removeEventListener("abort", i), r(e);
		});
	});
}
var fe = class {
	constructor(e) {
		this.info = {
			state: "idle",
			method: null,
			attempts: 0,
			workerStarts: 0,
			fallbackReason: null
		}, this.options = e;
	}
	load(e) {
		if (e?.aborted) return Promise.reject(E(e));
		if (!this.job) {
			let e = this.prepare().catch((t) => {
				this.job === e && (this.job = void 0), this.info.state = "failed";
				try {
					this.options.onFailure?.(t);
				} catch {}
				throw t;
			});
			this.job = e;
		}
		return e ? de(this.job, e) : this.job;
	}
	snapshot() {
		return { ...this.info };
	}
	async prepare() {
		this.info.state = "loading", this.info.method = null, this.info.fallbackReason = null, this.info.attempts++;
		let [e, t] = await Promise.all([this.options.loadModule(), this.options.loadGrid()]), n;
		try {
			this.info.state = "worker";
			let r = await this.prepareInWorker(t);
			n = e.validatePreparedTerrainModel(t, r), this.info.method = "worker";
		} catch (r) {
			this.info.state = "cooperative", this.info.fallbackReason = r instanceof Error ? r.message : "Terrain worker unavailable", n = e.validatePreparedTerrainModel(t, await e.createTerrainModelAsync(t)), this.info.method = "cooperative";
		}
		return n.grid = t, this.info.state = "ready", [
			e,
			t,
			n
		];
	}
	prepareInWorker(e) {
		let t = this.options.createWorker?.();
		if (!t) return Promise.reject(/* @__PURE__ */ Error("Terrain worker unsupported"));
		this.info.workerStarts++;
		let n = this.info.attempts;
		return new Promise((r, i) => {
			let a = !1, o = (e, n) => {
				a || (a = !0, c !== void 0 && clearTimeout(c), t.onmessage = null, t.onerror = null, t.onmessageerror = null, t.terminate(), e ? i(e) : r(n));
			};
			t.onmessage = (e) => {
				let t = e.data;
				if (!t || t.protocol !== 1 || t.requestId !== n) {
					o(/* @__PURE__ */ Error("Invalid terrain worker response"));
					return;
				}
				t.type === "terrain-prepared" ? o(void 0, t.model) : t.type === "terrain-error" ? o(/* @__PURE__ */ Error(`Terrain worker: ${String(t.error).slice(0, 400)}`)) : o(/* @__PURE__ */ Error("Unknown terrain worker response"));
			}, t.onerror = (e) => {
				e.preventDefault?.(), o(Error(e.message || "Terrain worker failed"));
			}, t.onmessageerror = () => o(/* @__PURE__ */ Error("Terrain worker message could not be decoded"));
			let s = this.options.timeoutMs ?? 2e4, c = setTimeout(() => o(/* @__PURE__ */ Error("Terrain worker timed out")), Number.isFinite(s) ? Math.max(1, s) : 2e4);
			try {
				t.postMessage({
					type: "prepare-terrain",
					protocol: 1,
					requestId: n,
					grid: e
				});
			} catch (e) {
				o(e instanceof Error ? e : /* @__PURE__ */ Error("Terrain worker could not receive the grid"));
			}
		});
	}
}, pe = [[19.6389282, 41.1858711], [191.0026658, 81.858721]], me = "#e7ebe2", D = (e, t, n) => Math.max(t, Math.min(n, e));
function O(e) {
	return Number.isFinite(e) ? e + 360 * Math.round((105 - e) / 360) : NaN;
}
function he(e, t, n, r) {
	let [[i, a], [o, s]] = pe, c = D(1 - (n - r.zoom) / 2, 0, 1), l = a + Math.min(0, r.center[1] - a) * c, u = s + Math.max(0, r.center[1] - s) * c;
	return {
		center: [D(O(e), Math.min(i, r.center[0]), Math.max(o, r.center[0])), D(t, l, u)],
		zoom: D(n, Math.min(r.zoom, 18), 18)
	};
}
function ge(e, t, n, r) {
	let i = (e - n[0]) * (r[1] - n[1]) - (t - n[1]) * (r[0] - n[0]);
	return Math.abs(i) < 1e-10 && e >= Math.min(n[0], r[0]) - 1e-10 && e <= Math.max(n[0], r[0]) + 1e-10 && t >= Math.min(n[1], r[1]) - 1e-10 && t <= Math.max(n[1], r[1]) + 1e-10;
}
var k = 1e-10, _e = /* @__PURE__ */ new WeakMap(), ve = (e, t, n) => e >= n[0] - k && e <= n[2] + k && t >= n[1] - k && t <= n[3] + k;
function ye(e) {
	if (!e.length) return null;
	let t = [
		Infinity,
		Infinity,
		-Infinity,
		-Infinity
	];
	for (let [n, r] of e) t[0] = Math.min(t[0], n), t[1] = Math.min(t[1], r), t[2] = Math.max(t[2], n), t[3] = Math.max(t[3], r);
	let n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(e.length) * 2))), r = t[3] > t[1] ? n / (t[3] - t[1]) : 0, i = (e) => D(Math.floor((e - t[1]) * r), 0, n - 1), a = Array.from({ length: n }, () => []);
	for (let t = 0, n = e.length - 1; t < e.length; n = t++) {
		let r = i(Math.min(e[t][1], e[n][1]) - k), o = i(Math.max(e[t][1], e[n][1]) + k);
		for (let e = r; e <= o; e++) a[e].push(t);
	}
	return {
		points: e,
		bounds: t,
		buckets: a,
		bucket: i
	};
}
function A(e, t, n) {
	if (!n || !ve(e, t, n.bounds)) return !1;
	let r = !1;
	for (let i of n.buckets[n.bucket(t)]) {
		let a = n.points[i], o = n.points[i === 0 ? n.points.length - 1 : i - 1];
		if (t < Math.min(a[1], o[1]) - k || t > Math.max(a[1], o[1]) + k || e > Math.max(a[0], o[0]) + k) continue;
		let s = a[1] > t != o[1] > t;
		if (e < Math.min(a[0], o[0]) - k) {
			s && (r = !r);
			continue;
		}
		if (ge(e, t, a, o)) return !0;
		s && e < (o[0] - a[0]) * (t - a[1]) / (o[1] - a[1]) + a[0] && (r = !r);
	}
	return r;
}
function be(e) {
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
				let e = ye(n[0] || []);
				e && t.push({
					outer: e,
					holes: n.slice(1).map(ye).filter(Boolean)
				});
			}
		}
	};
	if (n(e), !t.length) return {
		polygons: t,
		buckets: []
	};
	let r = Math.min(...t.map((e) => e.outer.bounds[1])), i = Math.max(...t.map((e) => e.outer.bounds[3])), a = i > r ? 256 / (i - r) : 0, o = (e) => D(Math.floor((e - r) * a), 0, 255), s = Array.from({ length: 256 }, () => []);
	for (let e of t) {
		let t = o(e.outer.bounds[1] - k), n = o(e.outer.bounds[3] + k);
		for (let r = t; r <= n; r++) s[r].push(e);
	}
	return {
		south: r,
		north: i,
		bucket: o,
		buckets: s
	};
}
function j(e, t, n) {
	let r = O(e);
	if (!Number.isFinite(r) || !Number.isFinite(t) || !n || typeof n != "object") return !1;
	let i = _e.get(n);
	return i || (i = be(n), _e.set(n, i)), !i.buckets.length || t < i.south - k || t > i.north + k ? !1 : i.buckets[i.bucket(t)].some((e) => A(r, t, e.outer) && !e.holes.some((e) => A(r, t, e)));
}
var M = Object.freeze({
	manifestBytes: 512 * 1024,
	baseBytes: 8 * 1024 * 1024,
	cellBytes: 3 * 1024 * 1024,
	viewBytes: 24 * 1024 * 1024,
	cacheBytes: 24 * 1024 * 1024,
	concurrent: 3,
	cells: 192
}), xe = /* @__PURE__ */ new Set([
	"area",
	"mask",
	"territory",
	"territory-boundary"
]), Se = {
	Point: 0,
	MultiPoint: 1,
	LineString: 1,
	MultiLineString: 2,
	Polygon: 2,
	MultiPolygon: 3
}, N = (e) => ({
	type: "FeatureCollection",
	features: e
}), P = (e) => /* @__PURE__ */ Error(`coverage-${e}`);
function Ce(e) {
	if (e?.type !== "TropnikCoverage" || e.encoding !== "indexed-delta-1e7-v1" || !Array.isArray(e.positions) || e.positions.length % 2 || !Array.isArray(e.features)) throw P("encoding");
	let t = [], n = 0, r = 0;
	for (let i = 0; i < e.positions.length; i += 2) {
		let a = e.positions[i], o = e.positions[i + 1];
		if (!Number.isSafeInteger(a) || !Number.isSafeInteger(o) || (n += a, r += o, !Number.isSafeInteger(n) || !Number.isSafeInteger(r) || n < 0 || n > 36e8 || Math.abs(r) > 850511288)) throw P("coordinate");
		t.push([n / 1e7, r / 1e7]);
	}
	let i = (e, n) => {
		if (n === 0) {
			if (!Number.isSafeInteger(e) || e < 0 || e >= t.length) throw P("index");
			return t[e];
		}
		if (!Array.isArray(e) || !e.length) throw P("nesting");
		return e.map((e) => i(e, n - 1));
	}, a = e.features.map((e) => {
		if (e?.type !== "Feature" || !xe.has(e.properties?.role) || typeof e.properties.cell != "string" || !(e.geometry?.type in Se)) throw P("feature");
		return {
			...e,
			geometry: {
				type: e.geometry.type,
				coordinates: i(e.geometry.coordinates, Se[e.geometry.type])
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
function we(e) {
	return e <= 4 ? "overview" : e <= 8 ? "regional" : e <= 12 ? "local" : "source";
}
function Te(e, t, n) {
	let r = we(n);
	if (r === "overview") return [];
	let [i, a, o, s] = t;
	if (![
		i,
		a,
		o,
		s,
		n
	].every(Number.isFinite) || a > s || (o < i && (o += 360 * Math.ceil((i - o) / 360)), !Number.isFinite(o - i))) throw P("viewport");
	let c = Math.min(360, o - i), l = O(i + c / 2);
	i = l - c * .65, o = l + c * .65;
	let u = s - a;
	return a = Math.max(-85.0511288, a - u * .15), s = Math.min(85.0511288, s + u * .15), e.cells.filter((e) => e.levels[r] && [
		-360,
		0,
		360
	].some((t) => e.bounds[2] + t >= i && e.bounds[0] + t <= o && e.bounds[3] >= a && e.bounds[1] <= s));
}
function F(e) {
	if (e?.schemaVersion !== 1 || e.encoding !== "indexed-delta-1e7-v1" || !/^[a-f0-9]{16}$/.test(e.version) || !Array.isArray(e.cells) || e.cells.length > 1024) throw P("manifest");
	let t = (e, t) => {
		if (!e || typeof e.url != "string" || !/^\/(?:[\w-]+\/)*data\/map-coverage\//.test(e.url) || e.url.includes("..") || !e.url.endsWith(".coverage") || !Number.isSafeInteger(e.bytes) || e.bytes < 1 || e.bytes > t || !/^[a-f0-9]{64}$/.test(e.sha256)) throw P("descriptor");
	};
	t(e.base, M.baseBytes);
	let n = /* @__PURE__ */ new Set();
	for (let r of e.cells) {
		if (typeof r.id != "string" || n.has(r.id) || !Array.isArray(r.bounds) || r.bounds.length !== 4 || !r.bounds.every(Number.isFinite) || r.bounds[0] < 0 || r.bounds[2] > 360 || r.bounds[0] >= r.bounds[2] || r.bounds[1] >= r.bounds[3] || !r.levels) throw P("cell");
		n.add(r.id);
		for (let [e, n] of Object.entries(r.levels)) {
			if (![
				"regional",
				"local",
				"source"
			].includes(e)) throw P("level");
			t(n, M.cellBytes);
		}
	}
	return e;
}
async function I(e, t, n, r) {
	let i = await e(t, {
		signal: r,
		credentials: "same-origin"
	});
	if (!i.ok) throw P("http");
	if (Number(i.headers?.get?.("content-length")) > n) throw await i.body?.cancel(), P("size");
	if (!i.body?.getReader) {
		let e = new Uint8Array(await i.arrayBuffer());
		if (e.byteLength > n) throw P("size");
		return e;
	}
	let a = i.body.getReader(), o = [], s = 0;
	try {
		for (;;) {
			let { value: e, done: t } = await a.read();
			if (t) break;
			if (s += e.byteLength, s > n) throw await a.cancel(), P("size");
			o.push(e);
		}
	} finally {
		a.releaseLock();
	}
	let c = new Uint8Array(s), l = 0;
	for (let e of o) c.set(e, l), l += e.byteLength;
	return c;
}
async function Ee(e, t, n, r, i, a) {
	let o = await I(e, t.url, t.bytes, a);
	if (a?.aborted) throw new DOMException("Aborted", "AbortError");
	if (o.byteLength !== t.bytes) throw P("size");
	if ([...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", o))].map((e) => e.toString(16).padStart(2, "0")).join("") !== t.sha256) throw P("integrity");
	let s = JSON.parse(new TextDecoder().decode(o));
	if (s.coverageVersion !== n || s.lod !== r || i && s.cell !== i) throw P("identity");
	let c = Ce(s);
	if (i && c.features.some((e) => e.properties.cell !== i)) throw P("identity");
	return c;
}
function De(e, t) {
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
function Oe(e, t, n = {}) {
	F(e);
	let r = n.fetch ?? globalThis.fetch.bind(globalThis), i = new Map(e.cells.map((e) => [e.id, e])), a = new Map(e.cells.map((e) => [e.id, []]));
	for (let e of t.features) {
		let t = a.get(e.properties.cell);
		if (!t) throw P("identity");
		t.push(e);
	}
	let o = /* @__PURE__ */ new Set(), s = /* @__PURE__ */ new Map(), c = 0, l = 0, u, d = !1, f = "overview:", p = "overview:", m = {
		manifest: e,
		version: e.version,
		area: N([]),
		mask: N([]),
		territories: N([]),
		boundaries: N([]),
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
		m.area = N(t.filter((e) => e.properties.role === "area")), m.mask = N(((e) => n.canonicalMask ? e.map((e) => De(e, i)) : e)(t.filter((e) => e.properties.role === "mask"))), m.territories = N(t.filter((e) => e.properties.role === "territory")), m.boundaries = N(t.filter((e) => e.properties.role === "territory-boundary"));
	};
	g(/* @__PURE__ */ new Map());
	async function _(t, n) {
		if (d) return;
		let i = we(n), a = Te(e, t, n), o = a.map((e) => e.id).sort(), _ = `${i}:${o.join(",")}`;
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
			if (a.length > M.cells || a.reduce((e, t) => e + t.levels[i].bytes, 0) > M.viewBytes) throw P("budget");
			let t = /* @__PURE__ */ new Map(), n = 0;
			if (await Promise.all(Array.from({ length: Math.min(M.concurrent, a.length) }, async () => {
				for (; n < a.length && b();) {
					let o = a[n++], l = o.levels[i], u = `${i}:${o.id}`, d = s.get(u)?.bundle;
					if (d) {
						let e = s.get(u);
						s.delete(u), s.set(u, e);
					} else {
						if (d = await Ee(r, l, e.version, i, o.id, y), !b()) return;
						for (s.set(u, {
							bundle: d,
							bytes: l.bytes
						}), c += l.bytes; c > M.cacheBytes && s.size;) {
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
var L = /* @__PURE__ */ new Map();
async function ke(e = {}) {
	let t = e.manifestURL ?? "/data/map-coverage/manifest.json", n = e.fetch ?? globalThis.fetch.bind(globalThis), r = !e.fetch && L.get(t);
	r || (r = (async () => {
		let e = await I(n, t, M.manifestBytes), r = F(JSON.parse(new TextDecoder().decode(e)));
		return {
			manifest: r,
			base: await Ee(n, r.base, r.version, "overview")
		};
	})(), e.fetch || (L.set(t, r), r.catch(() => L.delete(t))));
	let { manifest: i, base: a } = await r;
	return Oe(i, a, e);
}
//#endregion
//#region web/lib/terrain-preparation.worker.ts?worker&url
var Ae = "" + new URL("../workers/terrain-preparation.worker-B8lieq38.js", import.meta.url).href, je = "20261106-3", R = new le(), Me = () => typeof location > "u" ? "https://map-preview.local" : location.origin, z, Ne = `/terrain/terrain-grid.json?v=${je}`;
new fe({
	loadModule: () => (z ||= import("./terrain-renderer-qT471hOA.js").catch((e) => {
		throw z = void 0, e;
	}), z),
	loadGrid: () => V(Ne),
	createWorker: () => typeof Worker > "u" ? void 0 : new Worker(new URL(Ae, location.href), {
		type: "module",
		name: "tropnik-terrain"
	}),
	onFailure: () => R.invalidate(Ne)
});
function B(e) {
	return ue(e, Me());
}
function V(e, t = 0) {
	let n = B(e);
	return n ? R.json(n, t) : Promise.reject(/* @__PURE__ */ Error("Unknown public map resource"));
}
function H(e, t = 1, n) {
	let r = B(e);
	return r ? R.get(r, t, n) : Promise.reject(/* @__PURE__ */ Error("Unknown public map resource"));
}
//#endregion
//#region web/lib/map-satellite.ts
var Pe = "tropnik-satellite", Fe = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg", Ie = "tropnik-satellite-overview", Le = "https://tiles.maps.eox.at/wmts/1.0.0/bluemarble_3857/default/g/{z}/{y}/{x}.jpg", Re = [
	176,
	61,
	183,
	72.5
], ze = {
	"eox-s2": {
		source: Pe,
		tiles: Fe,
		maxzoom: 14,
		attribution: "EOxCloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017), CC BY 4.0"
	},
	"eox-bluemarble": {
		source: Ie,
		tiles: Le,
		maxzoom: 8,
		attribution: "NASA Earth Observatory · Blue Marble · EOX::Maps"
	}
};
function Be({ west: e, south: t, east: n, north: r }) {
	if (![
		e,
		t,
		n,
		r
	].every(Number.isFinite)) return "eox-s2";
	let [i, a, o, s] = Re;
	return r < a || t > s ? "eox-s2" : (n < e && (n += 360 * Math.ceil((e - n) / 360)), n - e >= 360 || i + Math.ceil((e - o) / 360) * 360 <= n ? "eox-bluemarble" : "eox-s2");
}
//#endregion
//#region web/lib/custom-map-tiles.worker.ts?worker&url
var Ve = "" + new URL("../workers/custom-map-tiles.worker-GtnvHQzs.js", import.meta.url).href, He = 96, Ue = 288, We = 160, Ge = 3, Ke = 6, U = 8 * 1024 * 1024, W = (e, t) => (e % 2 ** t + 2 ** t) % 2 ** t;
function G(e) {
	let t = e.paintZoom === void 0 ? e.z : e.paintZoom;
	if (!Number.isInteger(e.z) || e.z < 0 || !Number.isInteger(t) || t < e.z || t > 18) throw Error("Invalid map paint zoom");
	return t;
}
function K(e) {
	return `${e.kind}:${e.z}/${e.x}/${e.y}:${e.paths === !1 ? 0 : 1}:${+!!e.transparent}:${G(e)}:${e.boundaries === !1 ? 0 : 1}`;
}
function qe(e, t, n, r = Math.min(e, 12)) {
	let i = 2 ** (e - r), a = t - Math.floor(t / i) * i, o = n - Math.floor(n / i) * i, s = [0], c = [0];
	a === 0 && s.push(-1), a === i - 1 && s.push(1), o === 0 && c.push(-1), o === i - 1 && c.push(1);
	let l = [];
	for (let e of c) for (let t of s) (t || e) && l.push({
		dx: t,
		dy: e
	});
	return l;
}
var Je = class {
	constructor(e = !1) {
		this.softwareRaster = e, this.cache = /* @__PURE__ */ new Map(), this.jobs = /* @__PURE__ */ new Map(), this.pinned = /* @__PURE__ */ new Set(), this.fetching = 0, this.serial = 0, this.disposed = !1, this.enabled = !0, this.errors = [];
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
		for (let [e, { work: t }] of this.jobs) !this.pinned.has(e) && t.stage !== "decoding" && (this.jobs.delete(e), t.controller.abort(), t.bytes = void 0, t.halo = void 0, t.reject(/* @__PURE__ */ Error("Map view changed")));
		this.evict(!0);
	}
	peek(e) {
		return this.cache.get(e);
	}
	load(e) {
		if (this.disposed) return Promise.reject(/* @__PURE__ */ Error("Map resources released"));
		let t;
		try {
			t = K(e);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : /* @__PURE__ */ Error("Invalid map tile request"));
		}
		let n = this.cache.get(t), r = this.jobs.get(t);
		if (n) return this.cache.delete(t), this.cache.set(t, n), Promise.resolve(n);
		if (r) return r.promise;
		if (this.jobs.size >= We) return Promise.reject(/* @__PURE__ */ Error("Map tile queue is full"));
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
		return this.localFiles ??= V("/offline-map/manifest.json").then((e) => new Set(e.files.map((e) => e.path))).catch(() => /* @__PURE__ */ new Set());
	}
	async source(e) {
		let { kind: t } = e.request, n = Math.min(e.request.z, t === "vector" ? 14 : t === "relief" ? 12 : e.request.z), r = 2 ** (e.request.z - n), i = Math.floor(e.request.x / r), a = Math.floor(e.request.y / r), o = W(i, n);
		if (e.sourceZ = n, t === "overview") return {
			url: `/maps/russia-relief/${n}/${o}/${a}.png`,
			local: !0,
			mime: "image/png"
		};
		if (t === "eox-s2" || t === "eox-bluemarble") return {
			url: ze[t].tiles.replace("{z}", String(n)).replace("{x}", String(o)).replace("{y}", String(a)),
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
			url: (await (this.template ??= V("https://tiles.openfreemap.org/planet/latest").then((e) => {
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
	async fetch(e) {
		let t = await this.source(e);
		if (!this.current(e)) return;
		e.local = t.local, e.mime = t.mime, e.sourceKey = t.url;
		let n = await H(t.url, 0, e.controller.signal);
		if (this.current(e)) {
			if (!n.byteLength || n.byteLength > U) throw Error("Map source exceeds tile budget");
			if (e.bytes = n.slice(0), e.request.kind === "relief") {
				let { z: r, x: i, y: a } = e.request, o = e.sourceZ, s = 2 ** (r - o), c = Math.floor(i / s), l = Math.floor(a / s), u = {
					tiles: [],
					missing: []
				};
				e.halo = u;
				let d = /* @__PURE__ */ new Map([[t.url, e.bytes]]), f = n.byteLength, p = e.local ? await this.files() : void 0;
				for (let t of qe(r, i, a, o)) {
					if (!this.current(e)) return;
					let n = W(c + t.dx, o), r = l + t.dy;
					if (r < 0 || r >= 2 ** o) {
						u.missing.push({
							...t,
							reason: "coverage"
						});
						continue;
					}
					let i = `terrain/tiles/${o}/${n}/${r}.png`, a = !!e.local && !!p?.has(i);
					if (!a && !navigator.onLine) {
						u.missing.push({
							...t,
							reason: "unavailable"
						});
						continue;
					}
					let s = a ? `/offline-map/${i}` : `https://tiles.mapterhorn.com/${o}/${n}/${r}.webp`, m = {
						...t,
						sourceKey: s,
						mime: a ? "image/png" : "image/webp",
						...!a && e.local ? { reduceToArchive: !0 } : {}
					};
					try {
						let n = d.get(s);
						if (!n) {
							if (f >= U) {
								u.missing.push({
									...t,
									reason: "budget"
								});
								continue;
							}
							let r = await H(s, 0, e.controller.signal);
							if (!this.current(e)) return;
							if (!r.byteLength) {
								u.missing.push({
									...t,
									reason: "invalid"
								});
								continue;
							}
							if (f + r.byteLength > U) {
								u.missing.push({
									...t,
									reason: "budget"
								});
								continue;
							}
							n = r.slice(0), d.set(s, n), f += n.byteLength;
						}
						u.tiles.push({
							...m,
							bytes: n
						});
					} catch {
						if (!this.current(e)) return;
						u.missing.push({
							...t,
							reason: "unavailable"
						});
					}
				}
			}
			this.current(e) && (e.stage = "ready");
		}
	}
	finish(e, t, n) {
		if (e.bytes = void 0, e.halo = void 0, this.jobs.get(e.key)?.work !== e) {
			t?.bitmap.close();
			return;
		}
		if (this.jobs.delete(e.key), t && !this.disposed && this.cache.size < Ue) this.cache.set(e.key, t), e.resolve(t), this.evict();
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
		for (let [t, n] of this.cache) this.pinned.has(t) || this.cache.size <= He && !(e && n.reliefCoverage?.missing.some((e) => e.reason !== "coverage")) || (this.cache.delete(t), n.bitmap.close());
	}
	decode(e) {
		try {
			if (!this.worker) {
				let e = new Worker(new URL(Ve, location.href), {
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
			e.bytes = void 0, e.halo = void 0, this.timer = setTimeout(() => this.failWorker(), 15e3), this.worker.postMessage({
				id: e.id,
				kind: e.request.kind === "vector" ? "vector" : e.request.kind === "relief" ? "relief" : "raster",
				bytes: t,
				z: e.request.z,
				x: e.request.x,
				y: e.request.y,
				paintZoom: G(e.request),
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
			for (let { work: t } of this.jobs.values()) if (t.stage === e && t.request.kind === i) return t;
		}
	}
	pump() {
		if (!(this.disposed || !this.enabled)) {
			if (!this.active) {
				let e = this.next("ready", this.lastDecodeKind);
				e && (this.lastDecodeKind = e.request.kind, this.decode(e));
			}
			for (; this.fetching < Ge && [...this.jobs.values()].filter((e) => e.work.stage === "ready").length + this.fetching < Ke;) {
				let e = this.next("queued", this.lastFetchKind);
				if (!e) break;
				this.lastFetchKind = e.request.kind, e.stage = "fetching", this.fetching++, this.fetch(e).catch((t) => this.finish(e, void 0, t instanceof Error ? t : /* @__PURE__ */ Error("Tile download failed"))).finally(() => {
					this.fetching--, this.pump();
				});
			}
		}
	}
	destroy() {
		if (!this.disposed) {
			this.disposed = !0, clearTimeout(this.timer), this.worker?.terminate(), this.worker = void 0;
			for (let { work: e } of this.jobs.values()) e.controller.abort(), e.bytes = void 0, e.halo = void 0, e.reject(/* @__PURE__ */ Error("Map resources released"));
			this.jobs.clear();
			for (let e of this.cache.values()) e.bitmap.close();
			this.cache.clear(), this.pinned.clear(), this.active = void 0;
		}
	}
};
//#endregion
//#region web/lib/russia-map.ts
async function Ye(e = !1) {
	return ke({ canonicalMask: e });
}
//#endregion
//#region web/lib/map-framing.ts
function q(e, t, n, r, i) {
	let a = he(e, t, n, r);
	if (!i || ![...i.center, i.zoom].every(Number.isFinite)) return a;
	let o = Math.max(0, Math.min(1, 1 - (n - i.zoom) / 2));
	if (!o) return a;
	let s = he(...i.center, n, r), c = i.center.map((e, t) => s.center[t] + (e - s.center[t]) * o), l = [O(e), t];
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
function Xe(e) {
	return 3 + Math.max(0, Math.min(1, ((Number.isFinite(e) ? e : 10) - 8) / 6)) * 2;
}
var J = Object.freeze({
	badgeSize: 32,
	labelWidth: 64,
	labelHeight: 24,
	labelGap: 4,
	clearance: 8
});
function Ze(e, t) {
	if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) return "hidden";
	if (!t) return "full";
	if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return "hidden";
	let n = Math.abs(e.x - t.x), r = Math.abs(e.y - t.y), i = J.badgeSize + J.clearance;
	if (n < i && r < i) return "hidden";
	let a = J.badgeSize + J.labelGap + J.labelHeight;
	return n < J.labelWidth + J.clearance && r < a + J.clearance ? "compact" : "full";
}
function Qe(e) {
	let t = e[0], n = e[1];
	if (!t) return;
	let r = Ze(t.project(), n?.project());
	t.element.dataset.routeEdgeDensity !== r && (t.element.dataset.routeEdgeDensity = r), n && n.element.dataset.routeEdgeDensity !== r && (n.element.dataset.routeEdgeDensity = r);
}
function $e(e) {
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
function et(e) {
	let t = document.createElement("div");
	t.className = `route-edge-marker route-edge-marker--${e.kind}`, t.dataset.routeEdgeDensity = "hidden", t.style.setProperty("--route-edge-badge-size", `${J.badgeSize}px`), t.style.setProperty("--route-edge-label-width", `${J.labelWidth}px`), t.style.setProperty("--route-edge-label-height", `${J.labelHeight}px`), t.style.setProperty("--route-edge-label-gap", `${J.labelGap}px`), t.setAttribute("role", "img"), t.setAttribute("aria-label", e.label);
	let n = document.createElement("span");
	n.className = "route-edge-badge", n.textContent = e.kind === "last" ? "Б" : "А", n.setAttribute("aria-hidden", "true");
	let r = document.createElement("span");
	return r.className = "route-edge-label", r.textContent = e.kind === "shared" ? "А · Б" : e.kind === "last" ? "Точка Б" : "Точка А", r.setAttribute("aria-hidden", "true"), t.appendChild(n), t.appendChild(r), t;
}
//#endregion
//#region web/lib/map-interaction.ts
function tt(e, t) {
	!e || ![
		t.longitude,
		t.latitude,
		t.zoom
	].every(Number.isFinite) || (e.dataset.mapEngine = t.engine, e.dataset.mapLongitude = String(t.longitude), e.dataset.mapLatitude = String(t.latitude), e.dataset.mapZoom = String(t.zoom), e.dataset.mapTileSize = String(t.tileSize), Number.isFinite(t.centerX) && Number.isFinite(t.centerY) ? (e.dataset.mapCenterX = String(t.centerX), e.dataset.mapCenterY = String(t.centerY)) : (delete e.dataset.mapCenterX, delete e.dataset.mapCenterY));
}
//#endregion
//#region web/lib/map-direction-marker.ts
function nt(e, t = document) {
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
var rt = 168;
function it(e) {
	return Math.min(rt, Math.max(84, Math.ceil([...e].length * 7.1 + 24)));
}
function Y(e, t, n) {
	e.style.getPropertyValue(t) !== n && e.style.setProperty(t, n);
}
var at = {
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
}, ot = [
	".map-context",
	".map-style-switch",
	".map-controls",
	".layer-control",
	".map-message",
	".map-preload-status",
	".map-legend",
	".map-attribution",
	".fact-card",
	".fact-closed",
	".explore-panel"
];
function st(e, t, n) {
	let r = t ? at.compact : at.wide, i = e.left + r.edge, a = e.right - r.right, o = e.top + r.top, s = Math.min(e.bottom - r.bottom, n ?? Infinity);
	return a - i < 160 && (a = e.right - r.edge), s - o < 96 && (o = e.top + r.edge, s = Math.min(e.bottom - r.edge, n ?? Infinity)), a = Math.max(i + 1, a), s = Math.max(o + 1, s), {
		left: i,
		right: a,
		top: o,
		bottom: s
	};
}
function ct(e, t) {
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
var X = (e, t, n) => ({
	left: e.left + t,
	right: e.right + t,
	top: e.top + n,
	bottom: e.bottom + n
}), lt = (e, t) => e.left >= t.left - .5 && e.right <= t.right + .5 && e.top >= t.top - .5 && e.bottom <= t.bottom + .5, Z = (e, t, n = 0) => e.left < t.right + n && e.right > t.left - n && e.top < t.bottom + n && e.bottom > t.top - n;
function ut(e, t, n, r = 8) {
	let i = ct(e, t), a = i.x, o = i.y, s = X(e, a, o), c = n.filter((e) => [...Object.values(e)].every(Number.isFinite) && e.right > e.left && e.bottom > e.top);
	for (let e = 0; e < Math.min(16, c.length + 4); e++) {
		let e = c.find((e) => Z(s, e, r));
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
			rect: X(s, e.dx, e.dy)
		})).filter((e) => lt(e.rect, t)).sort((e, t) => Math.abs(e.dx) + Math.abs(e.dy) - (Math.abs(t.dx) + Math.abs(t.dy)))[0];
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
function dt(e, t, n, r, i = 8) {
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
			let t = X(e, r, a), s = c.find((e) => Z(t, e, i));
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
		let s = X(e, r.x, r.y);
		if (!(Math.hypot((s.left + s.right - t.left - t.right) / 2, (s.top + s.bottom - t.top - t.bottom) / 2) > 44 + Math.max(a, o) / 2) && lt(s, n) && !c.some((e) => Z(s, e, i))) return {
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
function ft(e, t, n, r, i = 8) {
	let a = t.top - r.top - i, o = r.bottom - t.bottom - i;
	return e === "top" ? a >= n || a >= o ? "top" : "bottom" : o >= n || o >= a ? "bottom" : "top";
}
function pt(e, t) {
	let n = getComputedStyle(e);
	if (n.display === "none" || n.visibility === "hidden" || Number(n.opacity) === 0) return;
	let r = e.getBoundingClientRect();
	if (!(r.width < 2 || r.height < 2 || !Z(r, t))) return {
		left: r.left,
		right: r.right,
		top: r.top,
		bottom: r.bottom
	};
}
function mt(e) {
	if (typeof window > "u" || !window.visualViewport) return e;
	let t = window.visualViewport, n = {
		left: Math.max(e.left, t.offsetLeft),
		right: Math.min(e.right, t.offsetLeft + t.width),
		top: Math.max(e.top, t.offsetTop),
		bottom: Math.min(e.bottom, t.offsetTop + t.height)
	};
	return n.right - n.left >= 80 && n.bottom - n.top >= 80 ? n : e;
}
function ht(e) {
	let t = mt(e.getBoundingClientRect()), n = e.closest(".explore-layout") ?? e.parentElement ?? e, r = n.querySelector(".explore-panel"), i;
	if (r) {
		let e = r.getBoundingClientRect();
		e.left < t.right && e.right > t.left && e.top > t.top && e.top < t.bottom && (i = Math.max(t.top + 72, e.top - 12));
	}
	let a = Math.min(e.clientWidth, t.right - t.left) <= 700, o = st(t, a, i), s = ot.join(",");
	return {
		safe: o,
		obstacles: [...n.querySelectorAll(s)].filter((t) => t !== e && !t.contains(e)).map((e) => pt(e, t)).filter((e) => !!e),
		compact: a
	};
}
function gt(e, t) {
	let { safe: n, obstacles: r } = ht(t), i = [], a = [], o = [...e.values()].filter((e) => !e.hidden && e.isConnected).sort((e, t) => {
		let n = (e) => e.classList.contains("is-selected") ? 0 : e.classList.contains("direction-cluster") ? 1 : 2;
		return n(e) - n(t) || (e.dataset.regionId ?? "").localeCompare(t.dataset.regionId ?? "", "en");
	});
	for (let e of o) {
		let t = e.querySelector(".region-marker-count");
		t && (delete e.dataset.mapCountHidden, Y(t, "--map-count-shift-x", "0px"), Y(t, "--map-count-shift-y", "0px"), t.textContent && a.push({
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
				delete e.dataset.mapLabelHidden, Y(t, "--map-label-shift-x", "0px"), Y(t, "--map-label-shift-y", "0px");
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
	for (let { button: e, label: t, preferred: n } of i) e.dataset.mapLabelPlacement !== n && (e.dataset.mapLabelPlacement = n), delete e.dataset.mapLabelHidden, Y(t, "--map-label-max-width", `${Math.floor(Math.max(48, Math.min(n === "top" ? 230 : 168, s)))}px`), Y(t, "--map-label-shift-x", "0px"), Y(t, "--map-label-shift-y", "0px");
	for (let e of i) {
		let t = e.button.getBoundingClientRect(), r = e.label.getBoundingClientRect();
		r.width < 2 || r.height < 2 || (e.rect = r, e.placement = ft(e.preferred, t, r.height, n));
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
		e.shift = dt(e.rect, e.marker, n, [...r, ...t]), e.shift.hidden || r.push(X(e.rect, e.shift.x, e.shift.y));
	}
	for (let e of i) {
		if (!e.rect) continue;
		let t = ut(e.rect, n, r);
		e.shift = {
			x: Math.round(t.x),
			y: Math.round(t.y),
			hidden: t.hidden
		}, t.hidden || r.push(X(e.rect, e.shift.x, e.shift.y));
	}
	for (let { button: e, label: t, preferred: n, placement: r, shift: a } of i) a && (Y(t, "--map-label-shift-x", `${a.x}px`), Y(t, "--map-label-shift-y", `${a.y}px`), a.hidden && (e.dataset.mapLabelHidden = "true"), e.classList.toggle("map-label-shifted", a.x !== 0 || a.y !== 0 || r !== n));
	for (let { button: e, count: t, shift: n } of a) n && (Y(t, "--map-count-shift-x", `${n.x}px`), Y(t, "--map-count-shift-y", `${n.y}px`), n.hidden && (e.dataset.mapCountHidden = "true"));
}
function _t(e) {
	let t = e % 100, n = e % 10;
	return `${e} ${t >= 11 && t <= 14 ? "направлений" : n === 1 ? "направление" : n >= 2 && n <= 4 ? "направления" : "направлений"}`;
}
function vt(e, t) {
	return Math.abs(e.point.x - t.point.x) < (e.width + t.width) / 2 + 12 && Math.abs(e.point.y - t.point.y) < (e.height + t.height) / 2 + 12;
}
function yt(e, t) {
	let n = e.filter((e) => t.has(e.id)), r = n.length ? n : e, i = e.reduce((e, t) => e + t.center[1], 0) / e.length, a = Math.max(.15, Math.cos(i * Math.PI / 180)), o = (e) => e < 0 ? e + 360 : e, s = (t) => e.reduce((e, n) => {
		let r = (o(t.center[0]) - o(n.center[0])) * a, i = t.center[1] - n.center[1];
		return e + r * r + i * i;
	}, 0);
	return [...r].sort((e, t) => s(e) - s(t) || e.id.localeCompare(t.id))[0];
}
function bt(e, t, n = /* @__PURE__ */ new Set()) {
	let r = /* @__PURE__ */ new Map(), i = [...new Map(e.map((e) => [e.id, e])).values()].sort((e, t) => e.id.localeCompare(t.id));
	for (let e of i) r.set(e.id, t(e.center));
	let a = (e) => {
		e.sort((e, t) => e.id.localeCompare(t.id));
		let t = yt(e, n), i = e.map((e) => e.center[0] < 0 ? e.center[0] + 360 : e.center[0]), a = e.map((e) => e.center[1]);
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
			width: e.length > 1 ? 176 : it(t.name),
			height: e.length > 1 || t.name.length > 22 ? 88 : 72
		};
	}, o = i.filter((e) => {
		let t = r.get(e.id);
		return Number.isFinite(t.x) && Number.isFinite(t.y);
	}).map((e) => a([e]));
	for (let e = 0; e < o.length; e++) for (let t = e + 1; t < o.length; t++) if (vt(o[e], o[t])) {
		o[e] = a([...o[e].members, ...o[t].members]), o.splice(t, 1), e = -1;
		break;
	}
	return o.sort((e, t) => e.key.localeCompare(t.key));
}
function xt(e, t, n) {
	let r = e.members.length > 1;
	return {
		cluster: r,
		label: r ? _t(e.members.length) : e.anchor.name,
		count: r ? String(e.members.length) : n ? String(t) : "",
		ariaLabel: r ? `Приблизить ${_t(e.members.length)}: ${e.members.map((e) => e.name).join(", ")}` : `Открыть ${e.anchor.name}${n ? `, маршрутов в каталоге: ${t}` : ""}`
	};
}
function St(e, t, n, r, i) {
	let a = new Map(t.map((e) => [e.anchor.id, e])), o = [...e].find(([, e]) => e.ownerDocument.activeElement === e)?.[0];
	for (let [t, o] of e) {
		let e = a.get(t);
		if (o.hidden !== !e && (o.hidden = !e), !e) {
			o.removeAttribute("data-map-anchor-region-id"), o.removeAttribute("data-map-group-key");
			continue;
		}
		o.getAttribute("data-map-anchor-region-id") !== e.anchor.id && o.setAttribute("data-map-anchor-region-id", e.anchor.id), o.getAttribute("data-map-group-key") !== e.key && o.setAttribute("data-map-group-key", e.key);
		let s = xt(e, n.get(t) || 0, r);
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
function Ct(e) {
	return e <= 3 ? 13 : e < 6 ? 13 + (e - 3) * 4 / 3 : e < 10 ? 17 + (e - 6) * 3 / 4 : 20;
}
//#endregion
//#region web/lib/custom-map-symbols.ts
var wt = Object.freeze({
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
	]
}), Tt = /* @__PURE__ */ new Map();
function Et(e, t, n, r) {
	let i = Tt.get(t);
	i || (i = wt[t].map((e) => new Path2D(e)), Tt.set(t, i)), e.save(), e.translate(n, r), e.beginPath(), e.arc(0, 0, 12, 0, Math.PI * 2), e.fillStyle = "rgba(255,254,245,.96)", e.fill(), e.scale(20 / 28, 20 / 28), e.translate(-14, -14), e.lineWidth = 1.8, e.strokeStyle = t === "water" ? "#427c88" : "#315342", e.lineCap = "round", e.lineJoin = "round";
	for (let t of i) e.stroke(t);
	e.restore();
}
//#endregion
//#region web/lib/map-canvas-policy.ts
var Dt = /* @__PURE__ */ new WeakMap(), Ot = /swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render|\bwarp\b/i;
function kt(e = document) {
	let t = Dt.get(e);
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
				e && Ot.test(String(n.getParameter(e.UNMASKED_RENDERER_WEBGL))) && (r = "software");
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
	return Dt.set(e, i), i;
}
var At = "tropnik-map-label-inspection";
function jt(e) {
	if (!e || typeof e != "object") return null;
	let t = e, n = t.limit;
	return t.schemaVersion !== 1 || !Array.isArray(t.names) || t.names.length < 1 || t.names.length > 100 || !t.names.every((e) => typeof e == "string" && e.length > 0 && e.length <= 160) || new Set(t.names).size !== t.names.length || typeof n != "number" || !Number.isInteger(n) || n < 1 || n > 100 ? null : {
		schemaVersion: 1,
		names: [...t.names],
		limit: n
	};
}
function Mt(e) {
	return {
		...e,
		coordinate: [...e.coordinate],
		...e.rect ? { rect: { ...e.rect } } : {}
	};
}
function Nt(e, t, n) {
	let r = jt(n);
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
		candidates: a.slice(0, r.limit).map(Mt)
	};
}
//#endregion
//#region web/lib/custom-map-engine.ts
var Q = 64;
function Pt(e) {
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
		if (y = [], !((c - t + 1) * (f - d + 1) > Q * 4 && s > 0)) {
			outer: for (let l = d; l <= f; l++) for (let u = t; u <= c; u++) if (b(u, l, e) && (y.push({
				kind: r,
				z: s,
				x: u,
				y: l,
				paths: i,
				transparent: a,
				...r === "vector" ? { boundaries: o } : {},
				...r === "vector" || r === "relief" ? { paintZoom: Math.max(s, Math.min(18, Math.floor(n))) } : {}
			}), y.length > Q && s > 0)) break outer;
			if (y.length <= Q || s === 0) break;
		}
	}
	let x = 2 ** s;
	return y.sort((e, t) => Math.hypot(e.x + .5 - f.x * x, e.y + .5 - f.y * x) - Math.hypot(t.x + .5 - f.x * x, t.y + .5 - f.y * x));
}
var Ft = class {
	constructor(e, t) {
		this.framed = null, this.pitch = 0, this.padding = {}, this.size = {
			width: 1,
			height: 1
		}, this.pixelRatio = 1, this.coverageRevision = -1, this.coveragePaths = /* @__PURE__ */ new WeakMap(), this.markers = /* @__PURE__ */ new Map(), this.markerGroups = /* @__PURE__ */ new Map(), this.routeEdges = [], this.selectedShapes = [], this.mode = "detail", this.paths = !0, this.boundaryVisible = !0, this.reliefVisible = !0, this.generation = 0, this.currentKeys = "", this.disposed = !1, this.active = !0, this.eco = !1, this.additionalLabels = [], this.labelDiagnostics = [], this.labelDiagnosticTotal = 0, this.drawRevision = 0, this.labelRevision = 0, this.frame = 0, this.paintRequested = !1, this.labelsRequested = !1, this.animation = 0, this.zoomTarget = null, this.pointer = new ie({
			minZoom: -2,
			maxZoom: 18,
			rotate: !0
		}), this.pointerMoved = !1, this.listeners = [], this.obstacles = [], this.state = {
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
		}, this.element = e, this.options = t, this.camera = { ...t.camera }, this.floor = { ...t.camera }, this.rasterPolicy = kt(e.ownerDocument ?? document), this.tiles = new Je(this.rasterPolicy.softwareRaster), this.canvas = document.createElement("canvas"), this.canvas.className = "tropnik-map-canvas", this.canvas.tabIndex = 0, this.canvas.setAttribute("aria-label", "Карта России: перетаскивание и стрелки перемещают карту, колёсико и плюс или минус меняют масштаб."), this.canvas.setAttribute("role", "img"), e.appendChild(this.canvas), this.labelCanvas = document.createElement("canvas"), this.labelCanvas.className = "tropnik-map-labels", this.labelCanvas.hidden = !0, this.labelCanvas.setAttribute("aria-hidden", "true"), e.appendChild(this.labelCanvas), this.markerLayer = document.createElement("div"), this.markerLayer.className = "tropnik-marker-layer", e.appendChild(this.markerLayer);
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
		this.labelContext = r, this.resize = new ResizeObserver(() => this.resizeCanvas()), this.resize.observe(e), this.resizeCanvas(), this.bindInput(), Ye().then((e) => {
			if (this.disposed) {
				e.dispose();
				return;
			}
			this.coverage = e, this.applyCoverage(), this.unbindCoverage = e.subscribe(() => this.applyCoverage()), this.updateState({ ready: !0 }), this.options.onReady?.(this), this.schedule(), this.settled();
		}).catch(() => this.updateState({ error: "Границы карты не загрузились. Проверьте подключение и обновите страницу." }));
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
		this.active !== e && (this.active = e, this.tiles.setActive(e), e ? (this.schedule(), this.settled()) : (this.pointer.cancel(), this.stopAnimation(), cancelAnimationFrame(this.frame), this.frame = 0, clearTimeout(this.settleTimer), this.setMoving(!1)));
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
		return this.labelDiagnostics.slice(0, 512).map(Mt);
	}
	inspectLabels(e) {
		let t = Nt(this.labelDiagnostics, this.labelDiagnosticTotal, e);
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
	moveCamera(e, t, n = !1) {
		if (this.disposed) return;
		this.pointer.cancel(), this.stopAnimation();
		let r = q(e.center[0], e.center[1], e.zoom, {
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
			let e = Math.min(1, (performance.now() - c) / 240), t = 1 - (1 - e) ** 3;
			this.camera = {
				center: f({
					x: o.x + (s.x - o.x) * t,
					y: o.y + (s.y - o.y) * t
				}),
				zoom: a.zoom + (i.zoom - a.zoom) * t,
				bearingDegrees: (a.bearingDegrees ?? 0) + ((i.bearingDegrees ?? 0) - (a.bearingDegrees ?? 0)) * t
			}, this.draw(), e < 1 ? this.animation = requestAnimationFrame(l) : (this.animation = 0, this.zoomTarget = null, this.settled());
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
		if (this.disposed || !Number.isFinite(e)) return;
		let t = (this.zoomTarget ?? this.camera.zoom) + e;
		this.options.onGesture?.(), this.moveCamera(S(this.camera, this.size, t, void 0, {
			minZoom: this.floor.zoom,
			maxZoom: this.options.maxZoom ?? 18
		}), !0, !0);
	}
	north() {
		this.setCamera({
			...this.camera,
			bearingDegrees: 0
		}, !0);
	}
	setMode(e) {
		this.mode === e && !this.state.error || (this.mode = e, this.currentKeys = "", e !== "satellite" && (this.imagery = void 0, this.imageryOverlay = void 0), e === "overview" && (this.detail = void 0, this.relief = void 0), this.updateState({
			mode: e,
			error: "",
			...e === "overview" ? { reliefReady: !1 } : {},
			...e === "satellite" ? {} : {
				committedMode: e,
				imageryLoading: !1,
				imagerySource: void 0,
				imageryTarget: void 0
			}
		}), this.refreshTiles(), this.schedule());
	}
	setLayers(e) {
		e.paths !== void 0 && e.paths !== this.paths && (this.paths = e.paths, this.currentKeys = ""), e.boundaries !== void 0 && e.boundaries !== this.boundaryVisible && (this.boundaryVisible = e.boundaries, this.currentKeys = ""), e.relief !== void 0 && (this.reliefVisible = e.relief), this.refreshTiles(), this.schedule();
	}
	setRegion(e = []) {
		this.selectedShapes = [...e], this.updateSelectedArea(), this.schedule();
	}
	setRoute(e, t) {
		let n = e ? Pt(e) : void 0;
		if (this.route = n?.bounds.every(Number.isFinite) ? n : void 0, this.routeId = this.route ? t : void 0, this.element.dataset.mapRouteId = this.routeId || "", this.routeEdges.forEach((e) => e.element.remove()), this.routeEdges = [], e) for (let t of $e(e)) {
			let e = et(t);
			this.markerLayer.appendChild(e), this.routeEdges.push({
				element: e,
				project: () => this.project(t.coordinate)
			});
		}
		this.schedule();
	}
	setMarkers(e) {
		let t = new Set(e.map((e) => e.id));
		for (let [e, n] of this.markers) t.has(e) || (n.button.remove(), this.markers.delete(e));
		for (let t of e) {
			let e = this.markers.get(t.id);
			if (e && e.marker.kind !== t.kind && (e.button.remove(), this.markers.delete(t.id), e = void 0), !e) {
				let n = t.kind === "direction" ? nt({
					id: t.id,
					name: t.label
				}) : document.createElement("button");
				n.type = "button", n.dataset.mapMarkerId = t.id, t.kind !== "direction" && (n.className = `tropnik-point-marker tropnik-point-marker--${t.kind}`), n.addEventListener("click", () => {
					let e = this.markerGroups.get(t.id);
					if (e && e.members.length > 1) {
						this.options.onGesture?.();
						let t = C(e.bounds, this.size, {
							padding: this.padding,
							maxZoom: 11,
							referenceLongitude: 105
						});
						this.setCamera({
							...t,
							zoom: Math.max(this.camera.zoom + 1, t.zoom)
						}, !0);
					} else this.options.onMarker?.(t.id);
				}), this.markerLayer.appendChild(n), e = {
					marker: t,
					button: n
				}, this.markers.set(t.id, e);
			}
			e.marker = t, t.kind !== "direction" && (e.button.setAttribute("aria-label", t.kind === "trail" ? `Открыть маршрут ${t.label}` : t.label), e.button.dataset.trailId = t.kind === "trail" ? t.id : "", e.button.classList.toggle("is-selected", !!t.active), e.button.textContent = t.kind === "plan" ? t.label.slice(0, 2) : "");
		}
		this.schedule(!1);
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
		return t || (t = Pt(e).path, this.coveragePaths.set(e, t)), t;
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
		this.element.dataset.mapCoverage = JSON.stringify(e), this.element.dataset.mapCoverageLod = e.lod, this.element.dataset.mapCoverageState = e.ready ? "ready" : "loading", t ? this.schedule() : this.publishInspection();
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
		this.listen(this.element, At, ((e) => {
			let t = e.detail;
			!t || typeof t != "object" || (t.response = JSON.stringify(this.inspectLabels(t.request)));
		}));
		let e = (e) => {
			let t = this.pointerRect ?? this.canvas.getBoundingClientRect();
			return {
				x: e.clientX - t.left,
				y: e.clientY - t.top
			};
		};
		this.listen(this.canvas, "pointerdown", ((t) => {
			if (t.button !== 0 || !this.state.ready || !this.active) return;
			t.preventDefault(), this.canvas.focus({ preventScroll: !0 }), this.stopAnimation(), clearTimeout(this.settleTimer), this.options.onGesture?.(), this.pointerRect = this.canvas.getBoundingClientRect();
			let n = e(t);
			this.pointer.begin(t.pointerId, this.flatPoint(n), this.camera, this.size), this.setMoving(!0), this.pointer.activePointers === 1 ? (this.pointerStart = {
				...n,
				time: performance.now(),
				id: t.pointerId
			}, this.pointerMoved = !1) : this.pointerMoved = !0, this.canvas.setPointerCapture(t.pointerId), this.canvas.classList.add("is-moving");
		})), this.listen(this.canvas, "pointermove", ((t) => {
			if (!this.pointer.activePointers) return;
			let n = e(t), r = this.pointer.move(t.pointerId, this.flatPoint(n));
			if (!r) return;
			this.pointerStart && Math.hypot(n.x - this.pointerStart.x, n.y - this.pointerStart.y) > 5 && (this.pointerMoved = !0);
			let i = q(r.center[0], r.center[1], r.zoom, {
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
		let t = ((t) => {
			let n = this.pointerStart, r = e(t), i = t.type === "pointerup" && !this.pointerMoved && n?.id === t.pointerId && performance.now() - n.time < 700;
			this.pointer.end(t.pointerId), this.canvas.hasPointerCapture(t.pointerId) && this.canvas.releasePointerCapture(t.pointerId), this.pointer.activePointers || (this.pointerRect = void 0, this.pointerStart = void 0, this.canvas.classList.remove("is-moving"), this.settled()), i && this.options.onClick?.(r, this.unproject(r));
		});
		this.listen(this.canvas, "pointerup", t), this.listen(this.canvas, "pointercancel", t), this.listen(this.canvas, "lostpointercapture", ((e) => {
			let t = this.pointer.activePointers;
			this.pointer.end(e.pointerId), t && !this.pointer.activePointers && (this.pointerRect = void 0, this.pointerStart = void 0, this.canvas.classList.remove("is-moving"), this.settled());
		})), this.listen(this.canvas, "wheel", ((t) => {
			if (!this.state.ready || !this.active) return;
			t.preventDefault(), this.options.onGesture?.(), this.stopAnimation();
			let n = S(this.camera, this.size, this.camera.zoom + oe(t.deltaY, t.deltaMode, this.size.height), this.flatPoint(e(t)), {
				minZoom: this.floor.zoom,
				maxZoom: this.options.maxZoom ?? 18
			}), r = q(n.center[0], n.center[1], n.zoom, {
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
			let t = se(this.camera, this.size, e.key, {
				minZoom: this.floor.zoom,
				maxZoom: this.options.maxZoom ?? 18
			});
			t ? (e.preventDefault(), this.options.onGesture?.(), this.setCamera(t, !0)) : e.key === "Home" && (e.preventDefault(), this.setCamera(this.floor, !0));
		})), this.listen(window, "blur", () => {
			this.pointer.cancel(), this.canvas.classList.remove("is-moving"), this.settled();
		}), this.listen(window, "online", () => {
			this.currentKeys = "", this.updateState({ error: "" }), this.refreshTiles();
		}), this.listen(window, "offline", () => {
			this.currentKeys = "", this.updateState({ error: "Нет сети. Доступны сохранённые границы, маршруты и загруженные участки карты." }), this.refreshTiles();
		});
	}
	resizeCanvas() {
		if (this.disposed) return;
		let e = Math.max(1, this.element.clientWidth), t = Math.max(1, this.element.clientHeight);
		if (!(e === this.size.width && t === this.size.height && this.canvas.width > 1)) {
			this.pointer.cancel(), this.size = {
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
			this.paintRequested = !1, this.labelsRequested = !1, e ? this.draw() : (t && (this.drawLabels(), this.publishInspection()), this.drawMarkers());
		}));
	}
	scheduleLabels() {
		this.labelsRequested = !0, this.schedule(!1);
	}
	settled() {
		if (this.disposed || !this.active) return;
		this.setMoving(!1), tt(this.element, {
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
			this.disposed || (gt(new Map([...this.markers].filter(([, e]) => e.marker.kind === "direction").map(([e, t]) => [e, t.button])), this.element), Qe(this.routeEdges));
		}), this.coverage?.updateView([...e], this.camera.zoom).catch(() => void 0), this.refreshTiles(), this.schedule();
	}
	refreshTiles() {
		if (this.disposed || !this.active || !this.coverage) return;
		let e = this.virtualSize(), t = Math.max(0, Math.floor(this.camera.zoom)), n = $(this.camera, e, Math.min(4, t), "overview"), r = Math.min(18, Math.ceil(this.camera.zoom)), i = this.mode !== "overview" && t >= 5 ? $(this.camera, e, r, "vector", this.paths, this.mode === "satellite", this.boundaryVisible) : [], a = this.mode === "detail" && this.reliefVisible && t >= 5 ? $(this.camera, e, r, "relief") : [], o = this.getBounds(), s = Be({
			west: o[0],
			south: o[1],
			east: o[2],
			north: o[3]
		}), c = this.mode === "satellite" ? $(this.camera, e, Math.min(s === "eox-s2" ? 14 : 8, t), s) : [], l = this.mode === "satellite" && !this.imagery;
		!i.length && !l && (this.detail = void 0, this.imageryOverlay = void 0), !a.length && !l && (this.relief = void 0);
		let u = [
			...n,
			...i,
			...a,
			...c
		], d = u.map(K).join("|");
		if (d === this.currentKeys) return;
		this.currentKeys = d;
		let f = ++this.generation, p = () => [
			this.overview,
			this.detail,
			this.relief,
			this.imagery,
			this.imageryOverlay
		].flatMap((e) => e?.tiles.map((e) => e.key) || []);
		this.tiles.pin([...u.map(K), ...p()]), this.updateState({
			loading: u.length > 0,
			imageryLoading: c.length > 0,
			imageryTarget: c.length ? s : void 0,
			...!a.length && !l ? { reliefReady: !1 } : {},
			...!i.length && !l ? { localDetail: !1 } : {}
		});
		let m = !1, h = async (e, t, n, r = !1) => {
			if (!e.length) return;
			let i = await Promise.allSettled(e.map((e) => this.tiles.load(e)));
			if (this.disposed || f !== this.generation) return;
			let a = i.flatMap((e) => e.status === "fulfilled" ? [e.value] : []), o = i.length - a.length;
			a.length && (!r || !o) && (n({
				tiles: a,
				kind: t,
				generation: f
			}), this.schedule()), !r && o === e.length && t === "vector" && navigator.onLine && (m = !0, this.updateState({ error: "Подробности этого участка не загрузились. Обзор и маршрут сохранены; повторите выбор слоя." })), r && (o ? this.updateState({
				imageryLoading: !1,
				error: "Не все спутниковые снимки загрузились. Предыдущая карта сохранена; повторите выбор слоя при устойчивой связи."
			}) : this.updateState({
				imageryLoading: !1,
				imagerySource: s,
				committedMode: "satellite",
				...m ? {} : { error: "" }
			}));
		};
		Promise.all([
			h(n, "overview", (e) => {
				this.overview = e, !i.length && !c.length && navigator.onLine && this.updateState({
					error: "",
					committedMode: "overview"
				});
			}),
			h(i, "vector", (e) => {
				this.mode === "satellite" ? this.imageryOverlay = e : this.detail = e, this.updateState({
					localDetail: e.tiles.every((e) => e.local),
					...this.mode === "satellite" ? {} : {
						committedMode: "detail",
						...navigator.onLine ? { error: "" } : {}
					}
				});
			}),
			h(a, "relief", (e) => {
				this.relief = e, this.updateState({ reliefReady: !0 });
			}),
			h(c, s, (e) => {
				this.imagery = e, this.detail = void 0, this.relief = void 0, this.updateState({ reliefReady: !1 });
			}, !0)
		]).finally(() => {
			!this.disposed && f === this.generation && (this.tiles.pin([...u.map(K), ...p()]), this.updateState({ loading: !1 }));
		});
	}
	displayDetail() {
		return this.mode === "satellite" && this.imagery ? this.imageryOverlay : this.detail;
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
		if (this.mode !== "detail" || this.pitch !== 0 || (this.camera.bearingDegrees ?? 0) !== 0 || this.camera.zoom < 4.7 || this.camera.zoom > 12 || e?.kind !== "vector" || !e.tiles.length || e.tiles.length > Q) return !1;
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
		].every(Number.isSafeInteger) || m < p || g < h || h < 0 || g >= s || (m - p + 1) * (g - h + 1) > Q) return !1;
		let _ = /* @__PURE__ */ new Set();
		for (let t of e.tiles) {
			if (t.kind !== "vector" || t.transparent !== !1 || t.z !== o || !Number.isSafeInteger(t.x) || !Number.isInteger(t.y) || t.y < 0 || t.y >= s || t.bitmap.width !== 512 || t.bitmap.height !== 512) return !1;
			_.add(`${t.x}/${t.y}`);
		}
		for (let e = h; e <= g; e++) for (let t = p; t <= m; t++) if (!_.has(`${t}/${e}`)) return !1;
		return !0;
	}
	draw() {
		if (this.disposed || !this.active) return;
		let e = this.context, t = this.displayDetail(), n = this.detailCoversViewport(t);
		e.setTransform(1, 0, 0, 1, 0, 0), n || (e.fillStyle = me, e.fillRect(0, 0, this.canvas.width, this.canvas.height));
		let r = this.worldTransform();
		n || (this.area && (e.fillStyle = "#dce5cf", e.fill(this.area, "evenodd")), this.drawTiles(this.overview, .95));
		let i = this.mode === "satellite" && !!this.imagery;
		i && this.drawTiles(this.imagery), this.mode !== "overview" && this.camera.zoom >= 4.7 && (!i || t?.tiles[0]?.transparent) && this.drawTiles(t), !i && (this.mode === "detail" || this.state.committedMode === "detail") && this.reliefVisible && this.camera.zoom >= 4.7 && this.drawTiles(this.relief, .82), this.boundaryVisible && this.boundaries && (e.strokeStyle = i ? "rgba(245,248,232,.45)" : "rgba(95,123,87,.45)", e.lineWidth = .65 / r, e.stroke(this.boundaries)), this.selectedArea && (e.fillStyle = "rgba(92,128,70,.10)", e.fill(this.selectedArea, "evenodd")), this.selectedBoundary && (e.strokeStyle = i ? "#e7eacc" : "#688360", e.lineWidth = 1.3 / r, e.stroke(this.selectedBoundary)), this.route && (e.lineCap = "round", e.lineJoin = "round", e.strokeStyle = "#fffef5", e.lineWidth = (Xe(this.camera.zoom) + 3) / r, e.stroke(this.route.path), e.strokeStyle = "#244d3c", e.lineWidth = Xe(this.camera.zoom) / r, e.stroke(this.route.path)), this.mask && (e.fillStyle = me, e.fill(this.mask, "evenodd")), this.drawLabels(), this.element.dataset.mapPainted = "true", this.element.dataset.mapCanvas = "custom", this.element.dataset.mapDrawnRoute = this.routeId || "", this.drawRevision++, this.drawMarkers(), !this.pointer.activePointers && !this.animation && this.publishInspection(), this.options.onFrame?.(this.getCamera());
	}
	drawMarkers() {
		let e = [...this.markers.values()].filter((e) => e.marker.kind === "direction"), t = bt(e.map(({ marker: e }) => ({
			id: e.id,
			name: e.label,
			center: e.coordinate
		})), (e) => this.project(e), new Set([...this.markerGroups.values()].map((e) => e.key)));
		this.markerGroups = St(new Map(e.map((e) => [e.marker.id, e.button])), t, new Map(e.map((e) => [e.marker.id, e.marker.count || 0])), this.camera.zoom < 5, e.find((e) => e.marker.active)?.marker.id);
		for (let { marker: e, button: t } of this.markers.values()) {
			let n = this.project(e.coordinate), r = n.x < -22 || n.x > this.size.width + 22 || n.y < -22 || n.y > this.size.height + 22;
			e.kind === "direction" ? r && (t.hidden = !0) : t.hidden = r, t.style.transform = `translate(${n.x - 22}px,${n.y - 22}px)`;
		}
		for (let e of this.routeEdges) {
			let t = e.project();
			e.element.style.position = "absolute", e.element.style.left = `${t.x}px`, e.element.style.top = `${t.y}px`;
		}
	}
	drawLabels() {
		this.labelDiagnostics = [], this.labelDiagnosticTotal = 0;
		let e = this.labelContext;
		if (e.setTransform(1, 0, 0, 1, 0, 0), e.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height), e.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0), this.labelRevision++, !this.coverage) {
			this.labelCanvas.hidden = !0;
			return;
		}
		let t = this.obstacles.map((e) => ({ ...e })), n = /* @__PURE__ */ new Set(), r = this.additionalLabels.map((e) => ({
			id: e.id,
			coordinate: e.coordinate,
			label: {
				x: 0,
				y: 0,
				text: e.label,
				kind: e.kind ?? "place",
				rank: e.rank ?? 0
			},
			color: e.color
		})), i = this.displayDetail();
		if (i && this.mode !== "overview" && this.camera.zoom >= 5) for (let e of i.tiles) for (let t of e.labels) {
			let n = 2 ** e.z;
			r.push({
				id: `${e.key}:${t.text}`,
				coordinate: f({
					x: (e.x + t.x) / n,
					y: (e.y + t.y) / n
				}),
				label: t
			});
		}
		r.sort((e, t) => e.label.rank - t.label.rank), this.labelDiagnosticTotal = r.length;
		let a = 0;
		for (let { id: i, coordinate: o, label: s, color: c } of r) {
			let r = {
				id: i,
				label: s.text,
				coordinate: o,
				visible: !1,
				reason: "budget"
			};
			this.labelDiagnostics.length < 6400 && this.labelDiagnostics.push(r);
			let l = `${s.kind}:${s.symbol || ""}:${s.text}:${o[0].toFixed(6)},${o[1].toFixed(6)}`;
			if (a >= 64 || n.has(l)) continue;
			if (!j(o[0], o[1], this.coverage.area)) {
				r.reason = "outside-coverage";
				continue;
			}
			let u = this.project(o), d = s.priorityCity ? Ct(this.camera.zoom) : s.kind === "place" && s.rank < 3 ? 14 : 12;
			if (u.x < 24 || u.x > this.size.width - 24 || u.y < 32 || u.y > this.size.height - 20) {
				r.reason = "outside-viewport";
				continue;
			}
			let f = s.kind === "peak" && s.elevation !== void 0 ? `${s.text ? s.text + " · " : ""}${Math.round(s.elevation)} м` : s.text;
			e.font = `${s.kind === "place" ? "600" : "500"} ${d}px Manrope, sans-serif`;
			let p = u.y + (s.symbol ? 21 : 0), m = Math.max(e.measureText(f).width, s.symbol ? 24 : 0), h = d / 2 + 4, g = {
				left: u.x - m / 2 - 5,
				right: u.x + m / 2 + 5,
				top: s.symbol ? u.y - 14 : u.y - h,
				bottom: s.symbol && !f ? u.y + 14 : p + h
			};
			if (r.x = u.x, r.y = u.y, r.width = m, r.rect = g, g.left < 12 || g.right > this.size.width - 12 || g.top < 12 || g.bottom > this.size.height - 12) {
				r.reason = "outside-viewport";
				continue;
			}
			if (t.some((e) => g.left < e.right && g.right > e.left && g.top < e.bottom && g.bottom > e.top)) {
				r.reason = "collision";
				continue;
			}
			t.push(g), n.add(l), s.symbol && Et(e, s.symbol, u.x, u.y), f && (e.textAlign = "center", e.textBaseline = "middle", e.lineWidth = 3, e.strokeStyle = "rgba(255,254,245,.95)", e.strokeText(f, u.x, p), e.fillStyle = c && /^#[\da-f]{6}$/i.test(c) ? c : s.kind === "water" ? "#427c88" : "#344e3a", e.fillText(f, u.x, p)), a++, r.visible = !0, r.reason = "drawn";
		}
		this.labelCanvas.hidden = a === 0;
	}
	destroy() {
		this.disposed || (this.disposed = !0, cancelAnimationFrame(this.frame), this.stopAnimation(), clearTimeout(this.settleTimer), this.resize.disconnect(), this.pointer.cancel(), this.listeners.forEach(([e, t, n, r]) => e.removeEventListener(t, n, r)), this.listeners = [], this.unbindCoverage?.(), this.coverage?.dispose(), this.tiles.destroy(), this.canvas.remove(), this.labelCanvas.remove(), this.markerLayer.remove(), this.markers.clear(), this.routeEdges = [], this.coveragePaths = /* @__PURE__ */ new WeakMap(), this.area = void 0, this.mask = void 0, this.boundaries = void 0, this.selectedArea = void 0, this.selectedBoundary = void 0, this.labelDiagnostics = [], this.labelDiagnosticTotal = 0);
	}
}, It = Object.freeze({
	version: 1,
	CustomMapEngine: Ft,
	inRussiaCoverage: j
});
typeof window < "u" && Object.defineProperty(window, "TropnikMapAPI", {
	value: It,
	configurable: !1
});
//#endregion
export { Ft as n, j as r, It as t };
