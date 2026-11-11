import { n as e, r as t } from "./chunks/custom-map-entry-BnbG0QHr.js";
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
}, r = "https://map.tropnik.invalid", i = document.getElementById("map"), a, o = 0, s = 0, c, l = !1, u = new n(r, (e, t) => c?.setRoute(e, t)), d = "", f = 0, p = !1, m = !1, h = null, g = /* @__PURE__ */ new Map(), _;
function v(e, t = {}) {
	a?.postMessage(JSON.stringify({
		version: 1,
		generation: o,
		type: e,
		payload: t
	}));
}
function y(e) {
	d = e, document.documentElement.dataset.mapState = "failed", v("error", { message: e });
}
function b(e) {
	let t = e;
	if (!t || !Array.isArray(t.center) || t.center.length !== 2 || !t.center.every(Number.isFinite) || Math.abs(t.center[0]) > 720 || Math.abs(t.center[1]) > 85.052 || !Number.isFinite(t.zoom) || t.zoom < 0 || t.zoom > 17 || t.bearingDegrees !== void 0 && !Number.isFinite(t.bearingDegrees)) throw Error("Invalid map camera");
	return {
		center: [t.center[0], t.center[1]],
		zoom: t.zoom,
		bearingDegrees: t.bearingDegrees || 0
	};
}
function x() {
	let e = c, n = [], r = _ && e?.getLabelDiagnostics().find((e) => e.id === "domestic" && e.visible);
	if (l && _ && r?.rect && e?.getCoverage()) {
		let i = e.project([_.longitude, _.latitude]);
		for (let a = Math.ceil(r.rect.top); a < r.rect.bottom; a++) for (let o = Math.ceil(Math.max(r.rect.left, i.x + 2)); o < r.rect.right && n.length < 2048; o++) {
			let r = e.unproject({
				x: o + .5,
				y: a + .5
			});
			t(r[0], r[1], e.getCoverage().area) || n.push([o + .5, a + .5]);
		}
	}
	return {
		ready: !!e?.getState().ready && m,
		frame: f,
		error: d,
		camera: e?.getCamera(),
		pitch: e?.getPitch(),
		state: e?.getState(),
		rendered: e?.inspect(),
		size: e?.getSize(),
		routeId: i.dataset.mapDrawnRoute || "",
		coverage: e?.getCoverage()?.status,
		markers: [...i.querySelectorAll("[data-map-marker-id]")].map((e) => {
			let t = e.getBoundingClientRect(), n = i.getBoundingClientRect();
			return {
				id: e.dataset.mapMarkerId,
				hidden: e.hidden || getComputedStyle(e).display === "none",
				x: t.x - n.x + t.width / 2,
				y: t.y - n.y + t.height / 2,
				width: t.width,
				height: t.height
			};
		}),
		labels: e?.getLabelDiagnostics(),
		outsideLabelProbes: n,
		labelFixture: _ && {
			..._,
			point: e?.project([_.longitude, _.latitude])
		}
	};
}
async function S() {
	if (!l || !c?.getCoverage()) throw Error("Debug map fixture is unavailable");
	let e = c.getCoverage();
	c.setCamera({
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
	let u = (i + a) / 2;
	_ = {
		longitude: u,
		latitude: n
	}, c.setMarkers([]), c.setRoute(void 0), c.setPitch(0), c.setMode("detail"), c.setLayers({
		paths: !1,
		boundaries: !1,
		relief: !1
	}), c.setCamera({
		center: [u, n],
		zoom: 10
	}, !1), c.setLabels([{
		id: "domestic",
		coordinate: [u - 5e-4, n],
		label: "ПРИМОРСК",
		kind: "place",
		rank: 0,
		color: "#102018"
	}, {
		id: "foreign",
		coordinate: [u + .02, n],
		label: "ЗАРУБЕЖНЫЙ",
		kind: "place",
		rank: 0,
		color: "#102018"
	}]);
}
async function C(e, n) {
	if (!c) throw Error("Map has not initialized");
	switch (e) {
		case "camera":
			c.setCamera(b(n.camera), n.animate === !0);
			break;
		case "fit": {
			let e = n.bounds, t = Number(n.padding || 0);
			if (!Array.isArray(e) || e.length !== 4 || !e.every(Number.isFinite) || e[0] > e[2] || e[1] > e[3] || Math.abs(e[1]) > 85.052 || Math.abs(e[3]) > 85.052 || !Number.isFinite(t) || t < 0 || t > 300) throw Error("Invalid map bounds");
			c.fit(e, {
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
			g = new Map(e.map((e) => [e.id, e.coordinate])), c.setMarkers(e), c.setPosition(h);
			break;
		}
		case "route":
			await u.update(n);
			break;
		case "position": {
			let e = n.coordinate;
			if (e !== null && (!Array.isArray(e) || e.length !== 2 || !e.every(Number.isFinite))) throw Error("Invalid position");
			let r = e !== null && !!c.getCoverage() && t(e[0], e[1], c.getCoverage().area);
			h = r ? e : null, c.setPosition(h), v("position", {
				inside: r,
				measuredAt: n.measuredAt
			}), r && n.recenter === !0 && c.setCamera({
				center: e,
				zoom: 11
			}, !0);
			break;
		}
		case "region":
			if (!Array.isArray(n.shapes) || n.shapes.some((e) => typeof e != "string" || e.length > 160)) throw Error("Invalid region");
			c.setRegion(n.shapes);
			break;
		case "zoom": {
			let e = Number(n.delta);
			if (!Number.isFinite(e) || Math.abs(e) > 1) throw Error("Invalid zoom");
			c.zoomBy(e);
			break;
		}
		case "north":
			c.north();
			break;
		case "layers":
			c.setLayers({ relief: n.relief === !0 });
			break;
		case "pitch":
			c.setPitch(n.tilted === !0 ? 40 : 0);
			break;
		case "eco":
			c.setEco(n.enabled === !0), document.body.dataset.mapEco = String(n.enabled === !0);
			break;
		case "active":
			c.setActive(n.active === !0);
			break;
		case "network":
			c.setMode("overview"), c.setMode("detail");
			break;
		case "snapshot":
			if (!l) throw Error("Debug command disabled");
			v("snapshot", x());
			break;
		case "labelFixture":
			if (!l) throw Error("Debug command disabled");
			await S();
			break;
		case "destroy":
			u.dispose(), c.destroy(), c = void 0, a?.close(), a = void 0;
			break;
		default: throw Error("Unknown map command");
	}
}
window.addEventListener("message", (n) => {
	if (p || location.origin !== r || n.ports.length !== 1) return;
	let u;
	try {
		u = JSON.parse(String(n.data));
	} catch {
		return;
	}
	if (!(u.type !== "tropnik-map-port" || u.version !== 1 || !Number.isSafeInteger(u.generation) || u.generation <= 0)) {
		p = !0, o = u.generation, l = u.debug === !0, a = n.ports[0], a.onmessage = (e) => {
			try {
				let t = JSON.parse(String(e.data));
				if (t.version !== 1 || t.generation !== o || !Number.isSafeInteger(t.sequence) || t.sequence <= s || typeof t.type != "string" || !t.payload || typeof t.payload != "object") return;
				s = t.sequence;
				let n = s;
				C(t.type, t.payload).then(() => v("ack", { sequence: n }), (e) => {
					e?.name !== "AbortError" && v("commandError", {
						sequence: n,
						message: t.type === "route" ? "Линия маршрута не загрузилась. Карточка и обзорная карта доступны." : "Карта не смогла выполнить действие."
					});
				});
			} catch {
				y("Не удалось обработать состояние карты.");
			}
		}, a.start();
		try {
			c = new e(i, {
				camera: {
					center: [105, 62],
					zoom: 0
				},
				maxZoom: 17,
				onReady: () => {
					document.documentElement.dataset.mapState = "ready", v("ready");
				},
				onFrame: () => {
					f++, i.dataset.mapDetail = c && c.getCamera().zoom >= 10 ? "close" : "wide";
					let e = c?.getState().residentTiles || 0;
					!m && e > 0 && (m = !0, v("frame", {
						frame: f,
						sourceTiles: e
					}));
				},
				onSettled: (e) => {
					e.zoom < 10 && c && c.getPitch() > 0 && c.setPitch(0), v("camera", {
						camera: e,
						pitch: c?.getPitch() || 0
					});
				},
				onMarker: (e) => {
					let n = g.get(e), r = c?.getCoverage();
					n && r && t(n[0], n[1], r.area) && v("marker", { id: e });
				},
				onState: (e) => v("state", e)
			}), document.documentElement.dataset.mapState = "loading";
		} catch {
			y("Карта не открылась. Карточки и источники доступны.");
		}
	}
}), window.addEventListener("error", () => y("Карта не открылась. Карточки и источники доступны.")), window.addEventListener("unhandledrejection", (e) => {
	e.reason?.name !== "AbortError" && y("Карта не смогла загрузить данные. Сохранённые карточки доступны.");
});
//#endregion
