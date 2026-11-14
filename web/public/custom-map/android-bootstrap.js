import { a as e, i as t, n, r } from "./chunks/custom-map-entry-BI8jbDdf.js";
//#region tools/android-build/native-map-route.ts
var i = class {
	origin;
	setRoute;
	verify;
	version = 0;
	pending;
	disposed = !1;
	request;
	constructor(e, t, n = fetch, r) {
		this.origin = e, this.setRoute = t, this.verify = r, this.request = (...e) => n(...e);
	}
	async update(e) {
		if (this.disposed || !Number.isSafeInteger(e.version) || e.version <= this.version || (this.version = e.version, this.pending?.abort(), this.pending = void 0, this.setRoute(void 0), !e.url)) return;
		let t = new URL(e.url, this.origin);
		if (t.origin !== this.origin || t.username || t.password || !/^\/native-route\/\d+-\d+\.geojson$/.test(t.pathname) || t.search || t.hash) throw Error("Invalid route resource");
		let n = new AbortController();
		this.pending = n;
		try {
			let r = await this.request(t, {
				signal: n.signal,
				credentials: "omit",
				cache: "no-store"
			});
			if (!r.ok) throw Error("Route resource unavailable");
			let i = await r.arrayBuffer();
			if (!i.byteLength || i.byteLength > 16 * 1024 * 1024) throw Error("Invalid route resource length");
			let a = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(i));
			if (this.disposed || this.version !== e.version || n.signal.aborted) return;
			if (!a || ![
				"FeatureCollection",
				"Feature",
				"LineString",
				"MultiLineString",
				"GeometryCollection"
			].includes(a.type)) throw Error("Invalid route geometry");
			let o = await this.verify?.(i, a, e.id);
			if (this.disposed || this.version !== e.version || n.signal.aborted) return;
			this.setRoute(a, e.id, o);
		} catch (t) {
			if (!this.disposed && this.version === e.version && !n.signal.aborted) throw t;
		} finally {
			this.pending === n && (this.pending = void 0);
		}
	}
	dispose() {
		this.disposed = !0, this.pending?.abort(), this.pending = void 0;
	}
}, a = 8 * 1024 * 1024, o = async (e) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", e))].map((e) => e.toString(16).padStart(2, "0")).join(""), s = (e) => typeof e == "string" && /^[a-z0-9-]{1,128}$/.test(e), c = class {
	origin;
	pending;
	lifetime = new AbortController();
	request;
	constructor(e, t = fetch) {
		this.origin = e, this.request = (...e) => t(...e);
	}
	manifest() {
		return this.lifetime.signal.aborted ? Promise.reject(new DOMException("Map disposed", "AbortError")) : (this.pending ||= this.readManifest().catch((e) => {
			throw this.pending = void 0, e;
		}), this.pending);
	}
	async readManifest() {
		let e = await this.request(this.origin + "/custom-map/catalogue.json", {
			signal: this.lifetime.signal,
			credentials: "omit",
			cache: "no-store"
		});
		if (!e.ok) throw Error("Native catalogue unavailable");
		let t = await e.arrayBuffer();
		if (t.byteLength > 2 * 1024 * 1024) throw Error("Native catalogue manifest exceeds budget");
		let n = JSON.parse(new TextDecoder("utf-8", { fatal: !0 }).decode(t)), r = (e) => e && Number.isSafeInteger(e.sizeBytes) && e.sizeBytes > 0 && e.sizeBytes <= a && /^[a-f0-9]{64}$/.test(e.sha256);
		if (n.schemaVersion !== 1 || !r(n.overlay) || !/^\/data\/trail-overlay-[a-f0-9]{16}\.json$/.test(n.overlay.url) || n.overlay.url !== `/data/trail-overlay-${n.overlay.sha256.slice(0, 16)}.json` || !Array.isArray(n.referenceRouteIds) || n.referenceRouteIds.length > 1e5 || n.referenceRouteIds.some((e) => !s(e)) || new Set(n.referenceRouteIds).size !== n.referenceRouteIds.length || !Array.isArray(n.sources) || n.sources.length > n.referenceRouteIds.length) throw Error("Invalid native catalogue manifest");
		let i = new Set(n.referenceRouteIds), o = /* @__PURE__ */ new Set(), c = /* @__PURE__ */ new Set();
		for (let e of n.sources) {
			if (!r(e) || !/^\/data\/(routes|imported)\/[a-z0-9-]+\.geojson$/.test(e.url) || o.has(e.url) || !Array.isArray(e.ids) || !e.ids.length || new Set(e.ids).size !== e.ids.length || e.ids.some((e) => !i.has(e) || c.has(e))) throw Error("Invalid native catalogue source");
			o.add(e.url);
			for (let t of e.ids) c.add(t);
		}
		return this.lifetime.signal.throwIfAborted(), n;
	}
	async load(e, t, n) {
		n.throwIfAborted(), this.lifetime.signal.throwIfAborted();
		let r = await this.manifest();
		n.throwIfAborted(), this.lifetime.signal.throwIfAborted();
		let i = new URL(e, this.origin), a = i.pathname + i.search;
		if (i.origin !== this.origin || i.username || i.password || i.hash || e !== a && e !== this.origin + a) throw Error("Invalid catalogue resource URL");
		let o = i.pathname === r.overlay.url ? r.overlay : r.sources.find((e) => e.url === i.pathname);
		if (!o || i.search && (o === r.overlay || i.search !== "?v=" + o.sha256.slice(0, 16))) throw Error("Unlisted catalogue resource");
		let s = await this.request(this.origin + o.url, {
			signal: n,
			credentials: "omit",
			cache: "no-store"
		});
		if (!s.ok) throw Error("Catalogue resource unavailable");
		let c = await s.arrayBuffer();
		if (n.throwIfAborted(), this.lifetime.signal.throwIfAborted(), c.byteLength !== o.sizeBytes) throw Error("Catalogue resource length mismatch");
		return c;
	}
	async verifyRoute(e, n, r) {
		if (!r) return;
		let i = (await this.manifest()).sources.find((e) => e.ids.includes(r));
		if (i) {
			if (e.byteLength !== i.sizeBytes || await o(e) !== i.sha256) throw Error("Selected native route integrity mismatch");
			return this.lifetime.signal.throwIfAborted(), t(i.url, n);
		}
	}
	dispose() {
		this.lifetime.abort(), this.pending = void 0;
	}
}, l = class {
	map;
	requested = "detail";
	online = !1;
	constructor(e) {
		this.map = e;
	}
	select(e) {
		if (e !== "detail" && e !== "satellite") throw Error("Invalid map mode");
		this.requested = e, this.map.setPitch(0), e === "detail" && this.map.setLayers({ relief: !0 }), this.apply();
	}
	network(e) {
		let t = e !== this.online;
		this.online = e, this.apply(), t && this.map.retry();
	}
	apply() {
		this.map.setMode(this.requested === "satellite" && this.online ? "satellite" : "detail");
	}
};
//#endregion
//#region tools/android-build/native-map-diagnostics.ts
async function u(e, t, n, r, i, a = () => new Promise((e) => setTimeout(e, 0))) {
	if (![...Object.values(e), t].every(Number.isFinite) || e.right <= e.left || e.bottom <= e.top || e.right - e.left > 8192 || e.bottom - e.top > 8192) throw Error("Invalid label evidence rectangle");
	let o = [], s = 0;
	if (!i()) throw new DOMException("Stale label evidence", "AbortError");
	for (let c = Math.ceil(e.top); c < e.bottom; c++) for (let l = Math.ceil(Math.max(e.left, t + 2)); l < e.right; l++) {
		if (o.length === 2048) return {
			probes: o,
			examined: s,
			limited: !0
		};
		let e = {
			x: l + .5,
			y: c + .5
		};
		if (s++, r(n(e)) || o.push([e.x, e.y]), s % 64 == 0 && (await a(), !i())) throw new DOMException("Stale label evidence", "AbortError");
	}
	if (!i()) throw new DOMException("Stale label evidence", "AbortError");
	return {
		probes: o,
		examined: s,
		limited: !1
	};
}
function d(e, t = 256 * 1024) {
	let n = {
		chars: 0,
		utf8Bytes: 0
	};
	e.payload.transport = n;
	let r = "";
	for (let i = 0; i < 6; i++) {
		r = JSON.stringify(e);
		let i = r.length, a = new TextEncoder().encode(r).byteLength;
		if (i === n.chars && a === n.utf8Bytes) return {
			encoded: i <= t ? r : void 0,
			...n
		};
		n.chars = i, n.utf8Bytes = a;
	}
	throw Error("Diagnostic size receipt did not converge");
}
//#endregion
//#region tools/android-build/custom-map-android.ts
var f = "https://map.tropnik.invalid", p = document.getElementById("map"), m, h = 0, g = 0, _, v = !1, y = new c(f), b = new i(f, (e, t, n) => _?.setRoute(e, t, n), fetch, (e, t, n) => y.verifyRoute(e, t, n)), x, S, C = [], w, T = !0, E = 0, D, O = "", k = 0, A = !1, j = !1, M = null, N = /* @__PURE__ */ new Map(), P, F = 0, I, L = "", R, z = [], B = 0;
function V(e) {
	let t = e, n = typeof t?.closest == "function" ? t.closest("[data-map-marker-id]") : null;
	return {
		tag: t?.tagName?.toLowerCase() || "",
		markerId: n?.dataset.mapMarkerId || "",
		groupKey: n?.dataset.mapGroupKey || n?.dataset.mapMarkerId || ""
	};
}
function H() {
	for (let e of [
		"pointerdown",
		"pointerup",
		"pointercancel",
		"click",
		"contextmenu"
	]) p.addEventListener(e, (t) => {
		if (!v || !t.isTrusted) return;
		let n = t, r = {
			sequence: ++B,
			type: e,
			trusted: !0,
			timeStamp: t.timeStamp,
			receivedAt: performance.now(),
			x: n.clientX,
			y: n.clientY,
			pointerId: n.pointerId,
			pointerType: n.pointerType,
			target: V(t.target),
			frame: k,
			camera: _?.getCamera()
		};
		z.length === 16 && z.shift(), z.push(r), U("debugReceipt", {
			phase: "trusted-input",
			...r
		});
	}, {
		capture: !0,
		passive: !0
	});
}
function U(e, t = {}) {
	m?.postMessage(JSON.stringify({
		version: 1,
		generation: h,
		type: e,
		payload: t
	}));
}
function W() {
	let e = _;
	e?.getState().ready && (x ? x.update({
		ids: T && !P ? C : [],
		selectedId: w,
		bounds: [...e.getBounds()],
		zoom: e.getCamera().zoom
	}) : C.length && T && !S && (S = y.manifest().then((t) => {
		_ === e && (U("overlayError", { message: "" }), x = new r({
			url: t.overlay.url,
			sha256: t.overlay.sha256,
			load: (e, t, n) => y.load(e, t, n),
			onChange: (t) => {
				_ === e && e.setTrailOverlay(t);
			},
			onError: (t) => {
				_ === e && U("overlayError", { message: t });
			}
		}), W());
	}).catch((t) => {
		_ === e && t?.name !== "AbortError" && U("overlayError", { message: "Линии троп не загрузились. Повторите загрузку карты." });
	}).finally(() => {
		S = void 0;
	})));
}
function G(e) {
	O = e, document.documentElement.dataset.mapState = "failed", U("error", { message: e });
}
function K(e) {
	let t = e;
	if (!t || !Array.isArray(t.center) || t.center.length !== 2 || !t.center.every(Number.isFinite) || Math.abs(t.center[0]) > 720 || Math.abs(t.center[1]) > 85.052 || !Number.isFinite(t.zoom) || t.zoom < 0 || t.zoom > 17 || t.bearingDegrees !== void 0 && !Number.isFinite(t.bearingDegrees)) throw Error("Invalid map camera");
	return {
		center: [t.center[0], t.center[1]],
		zoom: t.zoom,
		bearingDegrees: t.bearingDegrees || 0
	};
}
function q() {
	let e = _, { labels: t, ...n } = e?.inspect() || {}, r = I?.key === J() ? I.value : void 0, i = e?.getCamera(), a = e?.getPitch(), o = e?.getSize(), s = p.getBoundingClientRect(), c = p.dataset.mapMoving === "true", l = !!e?.getState().ready && j, u = l && !!R && !!i && !!o && !c && i.center[0] === R.camera.center[0] && i.center[1] === R.camera.center[1] && i.zoom === R.camera.zoom && (i.bearingDegrees || 0) === (R.camera.bearingDegrees || 0) && a === R.pitch && o.width === R.size.width && o.height === R.size.height && o.width === p.clientWidth && o.height === p.clientHeight;
	return {
		ready: l,
		frame: k,
		error: O,
		camera: i,
		pitch: a,
		moving: c,
		inputReady: u,
		painted: R,
		state: e?.getState(),
		rendered: n,
		catalogue: {
			visibleIds: C,
			selectedId: w,
			paths: T,
			loader: x?.inspect()
		},
		requestedMode: D?.requested,
		online: D?.online,
		centerTrailHit: v && e && o ? e.pickTrail({
			x: o.width / 2,
			y: o.height / 2
		}, 8) : void 0,
		size: o,
		viewportSize: {
			width: p.clientWidth,
			height: p.clientHeight
		},
		viewportBounds: {
			x: s.x,
			y: s.y,
			width: s.width,
			height: s.height
		},
		routeId: p.dataset.mapDrawnRoute || "",
		coverage: e?.getCoverage()?.status,
		trustedInput: [...z],
		markers: [...p.querySelectorAll("[data-map-marker-id]")].map((e) => {
			let t = e.getBoundingClientRect(), n = p.getBoundingClientRect(), r = e.hidden || getComputedStyle(e).display === "none", i = r ? null : document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2);
			return {
				id: e.dataset.mapMarkerId,
				groupKey: e.dataset.mapGroupKey || e.dataset.mapMarkerId,
				hidden: r,
				x: t.x - n.x + t.width / 2,
				y: t.y - n.y + t.height / 2,
				width: t.width,
				height: t.height,
				hitAtMarker: V(i)
			};
		}),
		labels: t,
		outsideLabelProbes: r?.probes || [],
		labelEvidence: r && {
			examined: r.examined,
			limited: r.limited
		},
		labelFixture: P && {
			...P,
			status: r ? "ready" : "preparing",
			point: e?.project([P.longitude, P.latitude])
		}
	};
}
function J() {
	if (!P || !_) return "";
	let e = _, t = e?.getLabelDiagnostics().find((e) => e.id === "domestic" && e.visible);
	return P && e?.getCoverage()?.status.ready && t?.rect ? JSON.stringify([
		F,
		e.getCamera(),
		e.getPitch(),
		e.getSize(),
		e.getCoverage()?.status.revision,
		t.rect
	]) : "";
}
function Y() {
	if (!v || !P) return;
	let t = _, n = J(), r = F;
	if (!v || !t || !n || n === I?.key || n === L || !P) return;
	let i = t.getLabelDiagnostics().find((e) => e.id === "domestic" && e.visible), a = t.getCoverage().area, o = t.project([P.longitude, P.latitude]);
	L = n;
	let s = performance.now();
	u(i.rect, o.x, (e) => t.unproject(e), (t) => e(t[0], t[1], a), () => _ === t && F === r && J() === n).then((e) => {
		_ !== t || J() !== n || (I = {
			key: n,
			value: e
		}, U("fixture", {
			status: "ready",
			frame: k,
			version: r,
			examined: e.examined,
			probes: e.probes.length,
			limited: e.limited,
			preparationMs: performance.now() - s
		}));
	}, (e) => {
		e?.name !== "AbortError" && U("fixture", {
			status: "error",
			version: r,
			message: "Label evidence could not be prepared"
		});
	}).finally(() => {
		L === n && (L = "");
	});
}
async function X() {
	if (!v || !_?.getCoverage()) throw Error("Debug map fixture is unavailable");
	let t = _.getCoverage();
	F++, I = void 0, P = void 0, U("fixture", {
		status: "preparing",
		version: F
	}), _.setCamera({
		center: [132, 43.1],
		zoom: 10
	}, !1), t.status.ready || await new Promise((e, n) => {
		let r = setTimeout(() => {
			i(), n(/* @__PURE__ */ Error("Coverage fixture did not settle"));
		}, 1e4), i = t.subscribe(() => {
			t.status.ready && (clearTimeout(r), i(), e());
		});
	}), await document.fonts.ready;
	let n = 43.1, r = (r) => e(r, n, t.area), i = 131.85, a = 132.15, o = !1, s = Infinity;
	for (let e = 131.85; e < 132.15; e += .01) r(e) && !r(e + .01) && Math.abs(e - 132) < s && (i = e, a = e + .01, s = Math.abs(e - 132), o = !0);
	if (!o) throw Error("Reviewed coast could not be resolved");
	for (let e = 0; e < 32; e++) {
		let e = (i + a) / 2;
		r(e) ? i = e : a = e;
	}
	let c = (i + a) / 2;
	P = {
		longitude: c,
		latitude: n
	}, W(), _.setMarkers([]), _.setRoute(void 0), _.setPitch(0), _.setMode("detail"), _.setLayers({
		paths: !1,
		boundaries: !1,
		relief: !1
	}), _.setCamera({
		center: [c, n],
		zoom: 10
	}, !1), _.setLabels([{
		id: "domestic",
		coordinate: [c - 5e-4, n],
		label: "ПРИМОРСК",
		kind: "place",
		rank: 0,
		color: "#102018"
	}, {
		id: "foreign",
		coordinate: [c + .02, n],
		label: "ЗАРУБЕЖНЫЙ",
		kind: "place",
		rank: 0,
		color: "#102018"
	}]);
}
async function Z(t, n) {
	if (!_) throw Error("Map has not initialized");
	switch (t) {
		case "camera":
			_.setCamera(K(n.camera), n.animate === !0);
			break;
		case "fit": {
			let e = n.bounds, t = Number(n.padding || 0);
			if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isFinite) || e[0] > e[2] || e[1] > e[3] || Math.abs(e[1]) > 85.052 || Math.abs(e[3]) > 85.052 || !Number.isFinite(t) || t < 0 || t > 300) throw Error("Invalid map bounds");
			_.fit(e, {
				top: t,
				right: t,
				bottom: t,
				left: t
			}, Number(n.maxZoom || 17), n.animate !== !1);
			break;
		}
		case "markers": {
			let e = n.markers;
			if (!Array.isArray(e) || e.length > 1024 || e.some((e) => typeof e.id != "string" || e.id.length > 160 || typeof e.label != "string" || e.label.length > 400 || ![
				"direction",
				"trail",
				"plan"
			].includes(e.kind) || !Array.isArray(e.coordinate) || e.coordinate.length !== 2 || !e.coordinate.every(Number.isFinite))) throw Error("Invalid map markers");
			N = new Map(e.map((e) => [e.id, e.coordinate])), _.setMarkers(e), _.setPosition(M);
			break;
		}
		case "route":
			if (!Number.isSafeInteger(n.version) || Number(n.version) <= E) break;
			E = Number(n.version), w = typeof n.id == "string" ? n.id : void 0, W(), await b.update(n);
			break;
		case "catalogue": {
			let e = n.ids;
			if (!Array.isArray(e) || e.length > 1e5 || e.some((e) => typeof e != "string" || !/^[a-z0-9-]{1,128}$/.test(e)) || new Set(e).size !== e.length) throw Error("Invalid map catalogue filter");
			C = [...e], W();
			break;
		}
		case "position": {
			let t = n.coordinate;
			if (t !== null && (!Array.isArray(t) || t.length !== 2 || !t.every(Number.isFinite))) throw Error("Invalid position");
			let r = t !== null && !!_.getCoverage() && e(t[0], t[1], _.getCoverage().area);
			M = r ? t : null, _.setPosition(M), U("position", {
				inside: r,
				measuredAt: n.measuredAt
			}), r && n.recenter === !0 && _.setCamera({
				center: t,
				zoom: 11
			}, !0);
			break;
		}
		case "region":
			if (!Array.isArray(n.shapes) || n.shapes.some((e) => typeof e != "string" || e.length > 160)) throw Error("Invalid region");
			_.setRegion(n.shapes);
			break;
		case "zoom": {
			let e = Number(n.delta);
			if (!Number.isFinite(e) || Math.abs(e) > 1) throw Error("Invalid zoom");
			_.zoomBy(e);
			break;
		}
		case "north":
			_.north();
			break;
		case "layers":
			n.paths !== void 0 && (T = n.paths === !0), _.setLayers({
				...n.relief === void 0 ? {} : { relief: n.relief === !0 },
				paths: T
			}), W();
			break;
		case "mode":
			D?.select(n.mode);
			break;
		case "retry":
			_.retry(), x?.retry(), W();
			break;
		case "pitch":
			_.setPitch(n.tilted === !0 ? 40 : 0);
			break;
		case "eco":
			_.setEco(n.enabled === !0), document.body.dataset.mapEco = String(n.enabled === !0);
			break;
		case "active":
			_.setActive(n.active === !0);
			break;
		case "network":
			D?.network(n.enabled === !0), n.enabled === !0 && x?.retry();
			break;
		case "snapshot": {
			if (!v || !Number.isSafeInteger(n.requestId)) throw Error("Debug command disabled");
			let e = performance.now();
			U("debugReceipt", {
				phase: "snapshot-start",
				requestId: n.requestId,
				startedAt: e,
				frame: k
			});
			let t = {
				...q(),
				requestId: n.requestId,
				timing: {
					startedAt: e,
					preparedAt: performance.now()
				}
			}, r = d({
				version: 1,
				generation: h,
				type: "snapshot",
				payload: t
			});
			r.encoded ? (m?.postMessage(r.encoded), U("debugReceipt", {
				phase: "snapshot-sent",
				requestId: n.requestId,
				finishedAt: performance.now(),
				chars: r.chars,
				utf8Bytes: r.utf8Bytes
			})) : U("debugReceipt", {
				phase: "snapshot-rejected",
				requestId: n.requestId,
				reason: "message-budget",
				chars: r.chars,
				utf8Bytes: r.utf8Bytes
			});
			break;
		}
		case "labelFixture":
			if (!v) throw Error("Debug command disabled");
			await X();
			break;
		case "destroy":
			b.dispose(), x?.destroy(), y.dispose(), _.destroy(), _ = void 0, D = void 0, m?.close(), m = void 0;
			break;
		default: throw Error("Unknown map command");
	}
}
window.addEventListener("message", (t) => {
	if (A || location.origin !== f || t.ports.length !== 1) return;
	let r;
	try {
		r = JSON.parse(String(t.data));
	} catch {
		return;
	}
	if (!(r.type !== "tropnik-map-port" || r.version !== 1 || !Number.isSafeInteger(r.generation) || r.generation <= 0)) {
		A = !0, h = r.generation, v = r.debug === !0, m = t.ports[0], v && H(), m.onmessage = (e) => {
			try {
				let t = JSON.parse(String(e.data));
				if (t.version !== 1 || t.generation !== h || !Number.isSafeInteger(t.sequence) || t.sequence <= g || typeof t.type != "string" || !t.payload || typeof t.payload != "object") return;
				g = t.sequence;
				let n = g;
				Z(t.type, t.payload).then(() => U("ack", { sequence: n }), (e) => {
					e?.name !== "AbortError" && U("commandError", {
						sequence: n,
						command: t.type,
						...v ? { detail: String(e?.message || e).slice(0, 240) } : {},
						message: t.type === "route" ? "Линия маршрута не загрузилась. Карточка и обзорная карта доступны." : "Карта не смогла выполнить действие."
					});
				});
			} catch {
				G("Не удалось обработать состояние карты.");
			}
		}, m.start();
		try {
			_ = new n(p, {
				camera: {
					center: [105, 62],
					zoom: 0
				},
				maxZoom: 17,
				onReady: () => {
					document.documentElement.dataset.mapState = "ready", U("ready"), W();
				},
				onFrame: (e) => {
					k++, p.dataset.mapDetail = _ && _.getCamera().zoom >= 10 ? "close" : "wide", v && _ && (R = {
						frame: k,
						camera: {
							...e,
							center: [...e.center]
						},
						pitch: _.getPitch(),
						size: { ..._.getSize() }
					});
					let t = _?.getState().residentTiles || 0;
					!j && t > 0 && (j = !0, U("frame", {
						frame: k,
						sourceTiles: t
					})), Y();
				},
				onSettled: (e) => {
					e.zoom < 10 && _ && _.getPitch() > 0 && _.setPitch(0), U("camera", {
						camera: e,
						pitch: _?.getPitch() || 0
					}), W();
				},
				onMarker: (t) => {
					let n = N.get(t), r = _?.getCoverage();
					n && r && e(n[0], n[1], r.area) && U("marker", { id: t });
				},
				onClick: (e) => {
					let t = _?.pickTrail(e, 8);
					t && (t === w || C.includes(t)) && U("trail", { id: t });
				},
				onOverlayError: (e) => U("rasterError", { message: e }),
				onState: (e) => U("state", {
					...e,
					requestedMode: D?.requested || "detail",
					online: D?.online || !1
				})
			}), D = new l(_), document.documentElement.dataset.mapState = "loading";
		} catch {
			G("Карта не открылась. Карточки и источники доступны.");
		}
	}
}), window.addEventListener("error", () => G("Карта не открылась. Карточки и источники доступны.")), window.addEventListener("unhandledrejection", (e) => {
	e.reason?.name !== "AbortError" && G("Карта не смогла загрузить данные. Сохранённые карточки доступны.");
});
//#endregion
