import { n as e, r as t } from "./chunks/custom-map-entry-B25YODzL.js";
//#region tools/android-build/native-map-route.ts
var n = class {
	origin;
	setRoute;
	request;
	version = 0;
	pending;
	disposed = !1;
	constructor(e, t, n = fetch) {
		this.origin = e, this.setRoute = t, this.request = n;
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
			let i = await r.json();
			if (this.disposed || this.version !== e.version || n.signal.aborted) return;
			if (!i || ![
				"FeatureCollection",
				"Feature",
				"LineString",
				"MultiLineString",
				"GeometryCollection"
			].includes(i.type)) throw Error("Invalid route geometry");
			this.setRoute(i, e.id);
		} catch (t) {
			if (!this.disposed && this.version === e.version && !n.signal.aborted) throw t;
		} finally {
			this.pending === n && (this.pending = void 0);
		}
	}
	dispose() {
		this.disposed = !0, this.pending?.abort(), this.pending = void 0;
	}
};
//#endregion
//#region tools/android-build/native-map-diagnostics.ts
async function r(e, t, n, r, i, a = () => new Promise((e) => setTimeout(e, 0))) {
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
function i(e, t = 256 * 1024) {
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
var a = "https://map.tropnik.invalid", o = document.getElementById("map"), s, c = 0, l = 0, u, d = !1, f = new n(a, (e, t) => u?.setRoute(e, t)), p = "", m = 0, h = !1, g = !1, _ = null, v = /* @__PURE__ */ new Map(), y, b = 0, x, S = "", C, w = [], T = 0;
function E(e) {
	let t = e, n = typeof t?.closest == "function" ? t.closest("[data-map-marker-id]") : null;
	return {
		tag: t?.tagName?.toLowerCase() || "",
		markerId: n?.dataset.mapMarkerId || "",
		groupKey: n?.dataset.mapGroupKey || n?.dataset.mapMarkerId || ""
	};
}
function D() {
	for (let e of [
		"pointerdown",
		"pointerup",
		"pointercancel",
		"click",
		"contextmenu"
	]) o.addEventListener(e, (t) => {
		if (!d || !t.isTrusted) return;
		let n = t, r = {
			sequence: ++T,
			type: e,
			trusted: !0,
			timeStamp: t.timeStamp,
			receivedAt: performance.now(),
			x: n.clientX,
			y: n.clientY,
			pointerId: n.pointerId,
			pointerType: n.pointerType,
			target: E(t.target),
			frame: m,
			camera: u?.getCamera()
		};
		w.length === 16 && w.shift(), w.push(r), O("debugReceipt", {
			phase: "trusted-input",
			...r
		});
	}, {
		capture: !0,
		passive: !0
	});
}
function O(e, t = {}) {
	s?.postMessage(JSON.stringify({
		version: 1,
		generation: c,
		type: e,
		payload: t
	}));
}
function k(e) {
	p = e, document.documentElement.dataset.mapState = "failed", O("error", { message: e });
}
function A(e) {
	let t = e;
	if (!t || !Array.isArray(t.center) || t.center.length !== 2 || !t.center.every(Number.isFinite) || Math.abs(t.center[0]) > 720 || Math.abs(t.center[1]) > 85.052 || !Number.isFinite(t.zoom) || t.zoom < 0 || t.zoom > 17 || t.bearingDegrees !== void 0 && !Number.isFinite(t.bearingDegrees)) throw Error("Invalid map camera");
	return {
		center: [t.center[0], t.center[1]],
		zoom: t.zoom,
		bearingDegrees: t.bearingDegrees || 0
	};
}
function j() {
	let e = u, { labels: t, ...n } = e?.inspect() || {}, r = x?.key === M() ? x.value : void 0, i = e?.getCamera(), a = e?.getPitch(), s = e?.getSize(), c = o.getBoundingClientRect(), l = o.dataset.mapMoving === "true", d = !!e?.getState().ready && g, f = d && !!C && !!i && !!s && !l && i.center[0] === C.camera.center[0] && i.center[1] === C.camera.center[1] && i.zoom === C.camera.zoom && (i.bearingDegrees || 0) === (C.camera.bearingDegrees || 0) && a === C.pitch && s.width === C.size.width && s.height === C.size.height && s.width === o.clientWidth && s.height === o.clientHeight;
	return {
		ready: d,
		frame: m,
		error: p,
		camera: i,
		pitch: a,
		moving: l,
		inputReady: f,
		painted: C,
		state: e?.getState(),
		rendered: n,
		size: s,
		viewportSize: {
			width: o.clientWidth,
			height: o.clientHeight
		},
		viewportBounds: {
			x: c.x,
			y: c.y,
			width: c.width,
			height: c.height
		},
		routeId: o.dataset.mapDrawnRoute || "",
		coverage: e?.getCoverage()?.status,
		trustedInput: [...w],
		markers: [...o.querySelectorAll("[data-map-marker-id]")].map((e) => {
			let t = e.getBoundingClientRect(), n = o.getBoundingClientRect(), r = e.hidden || getComputedStyle(e).display === "none", i = r ? null : document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2);
			return {
				id: e.dataset.mapMarkerId,
				groupKey: e.dataset.mapGroupKey || e.dataset.mapMarkerId,
				hidden: r,
				x: t.x - n.x + t.width / 2,
				y: t.y - n.y + t.height / 2,
				width: t.width,
				height: t.height,
				hitAtMarker: E(i)
			};
		}),
		labels: t,
		outsideLabelProbes: r?.probes || [],
		labelEvidence: r && {
			examined: r.examined,
			limited: r.limited
		},
		labelFixture: y && {
			...y,
			status: r ? "ready" : "preparing",
			point: e?.project([y.longitude, y.latitude])
		}
	};
}
function M() {
	if (!y || !u) return "";
	let e = u, t = e?.getLabelDiagnostics().find((e) => e.id === "domestic" && e.visible);
	return y && e?.getCoverage()?.status.ready && t?.rect ? JSON.stringify([
		b,
		e.getCamera(),
		e.getPitch(),
		e.getSize(),
		e.getCoverage()?.status.revision,
		t.rect
	]) : "";
}
function N() {
	if (!d || !y) return;
	let e = u, n = M(), i = b;
	if (!d || !e || !n || n === x?.key || n === S || !y) return;
	let a = e.getLabelDiagnostics().find((e) => e.id === "domestic" && e.visible), o = e.getCoverage().area, s = e.project([y.longitude, y.latitude]);
	S = n;
	let c = performance.now();
	r(a.rect, s.x, (t) => e.unproject(t), (e) => t(e[0], e[1], o), () => u === e && b === i && M() === n).then((t) => {
		u !== e || M() !== n || (x = {
			key: n,
			value: t
		}, O("fixture", {
			status: "ready",
			frame: m,
			version: i,
			examined: t.examined,
			probes: t.probes.length,
			limited: t.limited,
			preparationMs: performance.now() - c
		}));
	}, (e) => {
		e?.name !== "AbortError" && O("fixture", {
			status: "error",
			version: i,
			message: "Label evidence could not be prepared"
		});
	}).finally(() => {
		S === n && (S = "");
	});
}
async function P() {
	if (!d || !u?.getCoverage()) throw Error("Debug map fixture is unavailable");
	let e = u.getCoverage();
	b++, x = void 0, y = void 0, O("fixture", {
		status: "preparing",
		version: b
	}), u.setCamera({
		center: [132, 43.1],
		zoom: 10
	}, !1), e.status.ready || await new Promise((t, n) => {
		let r = setTimeout(() => {
			i(), n(/* @__PURE__ */ Error("Coverage fixture did not settle"));
		}, 1e4), i = e.subscribe(() => {
			e.status.ready && (clearTimeout(r), i(), t());
		});
	}), await document.fonts.ready;
	let n = 43.1, r = (r) => t(r, n, e.area), i = 131.85, a = 132.15, o = !1, s = Infinity;
	for (let e = 131.85; e < 132.15; e += .01) r(e) && !r(e + .01) && Math.abs(e - 132) < s && (i = e, a = e + .01, s = Math.abs(e - 132), o = !0);
	if (!o) throw Error("Reviewed coast could not be resolved");
	for (let e = 0; e < 32; e++) {
		let e = (i + a) / 2;
		r(e) ? i = e : a = e;
	}
	let c = (i + a) / 2;
	y = {
		longitude: c,
		latitude: n
	}, u.setMarkers([]), u.setRoute(void 0), u.setPitch(0), u.setMode("detail"), u.setLayers({
		paths: !1,
		boundaries: !1,
		relief: !1
	}), u.setCamera({
		center: [c, n],
		zoom: 10
	}, !1), u.setLabels([{
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
async function F(e, n) {
	if (!u) throw Error("Map has not initialized");
	switch (e) {
		case "camera":
			u.setCamera(A(n.camera), n.animate === !0);
			break;
		case "fit": {
			let e = n.bounds, t = Number(n.padding || 0);
			if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isFinite) || e[0] > e[2] || e[1] > e[3] || Math.abs(e[1]) > 85.052 || Math.abs(e[3]) > 85.052 || !Number.isFinite(t) || t < 0 || t > 300) throw Error("Invalid map bounds");
			u.fit(e, {
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
			v = new Map(e.map((e) => [e.id, e.coordinate])), u.setMarkers(e), u.setPosition(_);
			break;
		}
		case "route":
			await f.update(n);
			break;
		case "position": {
			let e = n.coordinate;
			if (e !== null && (!Array.isArray(e) || e.length !== 2 || !e.every(Number.isFinite))) throw Error("Invalid position");
			let r = e !== null && !!u.getCoverage() && t(e[0], e[1], u.getCoverage().area);
			_ = r ? e : null, u.setPosition(_), O("position", {
				inside: r,
				measuredAt: n.measuredAt
			}), r && n.recenter === !0 && u.setCamera({
				center: e,
				zoom: 11
			}, !0);
			break;
		}
		case "region":
			if (!Array.isArray(n.shapes) || n.shapes.some((e) => typeof e != "string" || e.length > 160)) throw Error("Invalid region");
			u.setRegion(n.shapes);
			break;
		case "zoom": {
			let e = Number(n.delta);
			if (!Number.isFinite(e) || Math.abs(e) > 1) throw Error("Invalid zoom");
			u.zoomBy(e);
			break;
		}
		case "north":
			u.north();
			break;
		case "layers":
			u.setLayers({ relief: n.relief === !0 });
			break;
		case "pitch":
			u.setPitch(n.tilted === !0 ? 40 : 0);
			break;
		case "eco":
			u.setEco(n.enabled === !0), document.body.dataset.mapEco = String(n.enabled === !0);
			break;
		case "active":
			u.setActive(n.active === !0);
			break;
		case "network":
			u.setMode("overview"), u.setMode("detail");
			break;
		case "snapshot": {
			if (!d || !Number.isSafeInteger(n.requestId)) throw Error("Debug command disabled");
			let e = performance.now();
			O("debugReceipt", {
				phase: "snapshot-start",
				requestId: n.requestId,
				startedAt: e,
				frame: m
			});
			let t = {
				...j(),
				requestId: n.requestId,
				timing: {
					startedAt: e,
					preparedAt: performance.now()
				}
			}, r = i({
				version: 1,
				generation: c,
				type: "snapshot",
				payload: t
			});
			r.encoded ? (s?.postMessage(r.encoded), O("debugReceipt", {
				phase: "snapshot-sent",
				requestId: n.requestId,
				finishedAt: performance.now(),
				chars: r.chars,
				utf8Bytes: r.utf8Bytes
			})) : O("debugReceipt", {
				phase: "snapshot-rejected",
				requestId: n.requestId,
				reason: "message-budget",
				chars: r.chars,
				utf8Bytes: r.utf8Bytes
			});
			break;
		}
		case "labelFixture":
			if (!d) throw Error("Debug command disabled");
			await P();
			break;
		case "destroy":
			f.dispose(), u.destroy(), u = void 0, s?.close(), s = void 0;
			break;
		default: throw Error("Unknown map command");
	}
}
window.addEventListener("message", (n) => {
	if (h || location.origin !== a || n.ports.length !== 1) return;
	let r;
	try {
		r = JSON.parse(String(n.data));
	} catch {
		return;
	}
	if (!(r.type !== "tropnik-map-port" || r.version !== 1 || !Number.isSafeInteger(r.generation) || r.generation <= 0)) {
		h = !0, c = r.generation, d = r.debug === !0, s = n.ports[0], d && D(), s.onmessage = (e) => {
			try {
				let t = JSON.parse(String(e.data));
				if (t.version !== 1 || t.generation !== c || !Number.isSafeInteger(t.sequence) || t.sequence <= l || typeof t.type != "string" || !t.payload || typeof t.payload != "object") return;
				l = t.sequence;
				let n = l;
				F(t.type, t.payload).then(() => O("ack", { sequence: n }), (e) => {
					e?.name !== "AbortError" && O("commandError", {
						sequence: n,
						command: t.type,
						...d ? { detail: String(e?.message || e).slice(0, 240) } : {},
						message: t.type === "route" ? "Линия маршрута не загрузилась. Карточка и обзорная карта доступны." : "Карта не смогла выполнить действие."
					});
				});
			} catch {
				k("Не удалось обработать состояние карты.");
			}
		}, s.start();
		try {
			u = new e(o, {
				camera: {
					center: [105, 62],
					zoom: 0
				},
				maxZoom: 17,
				onReady: () => {
					document.documentElement.dataset.mapState = "ready", O("ready");
				},
				onFrame: (e) => {
					m++, o.dataset.mapDetail = u && u.getCamera().zoom >= 10 ? "close" : "wide", d && u && (C = {
						frame: m,
						camera: {
							...e,
							center: [...e.center]
						},
						pitch: u.getPitch(),
						size: { ...u.getSize() }
					});
					let t = u?.getState().residentTiles || 0;
					!g && t > 0 && (g = !0, O("frame", {
						frame: m,
						sourceTiles: t
					})), N();
				},
				onSettled: (e) => {
					e.zoom < 10 && u && u.getPitch() > 0 && u.setPitch(0), O("camera", {
						camera: e,
						pitch: u?.getPitch() || 0
					});
				},
				onMarker: (e) => {
					let n = v.get(e), r = u?.getCoverage();
					n && r && t(n[0], n[1], r.area) && O("marker", { id: e });
				},
				onState: (e) => O("state", e)
			}), document.documentElement.dataset.mapState = "loading";
		} catch {
			k("Карта не открылась. Карточки и источники доступны.");
		}
	}
}), window.addEventListener("error", () => k("Карта не открылась. Карточки и источники доступны.")), window.addEventListener("unhandledrejection", (e) => {
	e.reason?.name !== "AbortError" && k("Карта не смогла загрузить данные. Сохранённые карточки доступны.");
});
//#endregion
