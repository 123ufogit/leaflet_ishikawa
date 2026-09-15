/**
 * flatgeobufHandler.js - FlatGeobuf (.fgb) ファイルの読み込み・CRS自動変換とLeaflet表示
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** FlatGeobuf ライブラリの CDN URL */
  const FLATGEOBUF_CDN = 'https://cdn.jsdelivr.net/npm/flatgeobuf/dist/flatgeobuf-geojson.min.js';

  /** Proj4 ライブラリの CDN URL */
  const PROJ4_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.15.0/proj4.js';

  let flatgeobufReady = false;
  let flatgeobufLoading = false;
  let flatgeobufCallbacks = [];

  let proj4Ready = false;
  let proj4Loading = false;
  let proj4Callbacks = [];

  /**
   * 日本の平面直交座標系（1系〜19系）の原点パラメータ
   * [北緯 lat, 東経 lon]
   */
  const JGD_PLANE_ZONES = {
    1:  { lat: 33.0, lon: 129.5 },
    2:  { lat: 33.0, lon: 131.0 },
    3:  { lat: 36.0, lon: 132 + 10 / 60 },
    4:  { lat: 33.0, lon: 133.5 },
    5:  { lat: 36.0, lon: 134 + 20 / 60 },
    6:  { lat: 36.0, lon: 136.0 },
    7:  { lat: 36.0, lon: 137 + 10 / 60 },
    8:  { lat: 36.0, lon: 138.5 },
    9:  { lat: 36.0, lon: 139 + 50 / 60 },
    10: { lat: 40.0, lon: 140 + 50 / 60 },
    11: { lat: 44.0, lon: 140.25 },
    12: { lat: 44.0, lon: 142.25 },
    13: { lat: 44.0, lon: 144.25 },
    14: { lat: 26.0, lon: 142.0 },
    15: { lat: 26.0, lon: 127.5 },
    16: { lat: 26.0, lon: 124.0 },
    17: { lat: 26.0, lon: 131.0 },
    18: { lat: 20.0, lon: 136.0 },
    19: { lat: 26.0, lon: 154.0 }
  };

  GIS.FlatGeobufHandler = {

    /**
     * FlatGeobuf ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureFlatgeobuf() {
      if (flatgeobufReady || window.flatgeobuf) {
        flatgeobufReady = true;
        return Promise.resolve();
      }
      if (flatgeobufLoading) {
        return new Promise((resolve, reject) => flatgeobufCallbacks.push({ resolve, reject }));
      }

      flatgeobufLoading = true;
      return new Promise((resolve, reject) => {
        flatgeobufCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = FLATGEOBUF_CDN;
        script.onload = () => {
          flatgeobufReady = true;
          flatgeobufLoading = false;
          flatgeobufCallbacks.forEach(cb => cb.resolve());
          flatgeobufCallbacks = [];
        };
        script.onerror = () => {
          flatgeobufLoading = false;
          const err = new Error('FlatGeobufライブラリの読み込みに失敗しました。');
          flatgeobufCallbacks.forEach(cb => cb.reject(err));
          flatgeobufCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    },

    /**
     * proj4.js ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureProj4() {
      if (proj4Ready || window.proj4) {
        proj4Ready = true;
        return Promise.resolve();
      }
      if (proj4Loading) {
        return new Promise((resolve, reject) => proj4Callbacks.push({ resolve, reject }));
      }

      proj4Loading = true;
      return new Promise((resolve, reject) => {
        proj4Callbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = PROJ4_CDN;
        script.onload = () => {
          proj4Ready = true;
          proj4Loading = false;
          proj4Callbacks.forEach(cb => cb.resolve());
          proj4Callbacks = [];
        };
        script.onerror = () => {
          proj4Loading = false;
          const err = new Error('Proj4ライブラリの読み込みに失敗しました。');
          proj4Callbacks.forEach(cb => cb.reject(err));
          proj4Callbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    },

    /**
     * 日本の平面直交系 EPSG コードを Proj4 に登録する
     * @param {number} epsg
     * @returns {{zone: number, name: string, epsgStr: string}|null}
     */
    _registerJgdPlaneZone(epsg) {
      if (!window.proj4) return null;
      let zone = null;
      let name = '';
      if (epsg >= 6669 && epsg <= 6687) {
        zone = epsg - 6668;
        name = `JGD2011 平面直交第${zone}系`;
      } else if (epsg >= 2443 && epsg <= 2461) {
        zone = epsg - 2442;
        name = `JGD2000 平面直交第${zone}系`;
      }
      if (!zone || !JGD_PLANE_ZONES[zone]) return null;

      const info = JGD_PLANE_ZONES[zone];
      const epsgStr = `EPSG:${epsg}`;
      if (!window.proj4.defs[epsgStr]) {
        const proj4Def = `+proj=tmerc +lat_0=${info.lat} +lon_0=${info.lon} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`;
        window.proj4.defs(epsgStr, proj4Def);
      }
      return { zone, name, epsgStr };
    },

    /**
     * FlatGeobuf (.fgb) ファイルまたはURLを読み込み、地図に表示する
     * @param {File|string} fileOrUrl
     * @param {string} [customName]
     */
    async load(fileOrUrl, customName, isLayerSet = false) {
      if (!fileOrUrl) return;

      const isFile = (typeof fileOrUrl !== 'string' && fileOrUrl instanceof Blob);
      const fileName = isFile ? fileOrUrl.name : (customName || fileOrUrl.split('/').pop() || 'flatgeobuf.fgb');

      GIS.UI.showToast(`⚡ FlatGeobuf 準備中: ${fileName}`, 'info');
      await Promise.all([this._ensureFlatgeobuf(), this._ensureProj4()]);

      if (!window.flatgeobuf || typeof window.flatgeobuf.deserialize !== 'function') {
        throw new Error('FlatGeobuf デシリアライザが見つかりません。');
      }

      GIS.UI.showToast(`⚡ FlatGeobuf 読み込み中: ${fileName}`, 'info');

      let headerMeta = null;
      const features = [];

      try {
        let input;
        if (isFile) {
          if (typeof fileOrUrl.stream === 'function') {
            input = fileOrUrl.stream();
          } else {
            const buffer = await fileOrUrl.arrayBuffer();
            input = new Uint8Array(buffer);
          }
        } else {
          // URL指定の場合
          const response = await fetch(fileOrUrl);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          input = response.body || new Uint8Array(await response.arrayBuffer());
        }

        // 第3引数に headerMetaFn を渡してヘッダーメタデータを取得
        const iterator = window.flatgeobuf.deserialize(input, undefined, (header) => {
          headerMeta = header;
        });

        for await (const feature of iterator) {
          features.push(feature);
        }
      } catch (e) {
        console.error('[FlatGeobufHandler] Deserialization error:', e);
        throw new Error(`FlatGeobufファイルの解析に失敗しました: ${e.message}`);
      }

      if (features.length === 0) {
        throw new Error('FlatGeobufファイル内にフィーチャが見つかりませんでした。');
      }

      // ------------------------------------------------------------------
      // CRS 判定と WGS84 への座標自動再投影
      // ------------------------------------------------------------------
      const sampleFeature = features[0];
      const crsResolution = this._resolveTransformer(headerMeta, sampleFeature);

      let geojsonFeatures = features;
      if (crsResolution.needsReproject && typeof crsResolution.transformFn === 'function') {
        GIS.UI.showToast(`🔄 座標系を変換中: [${crsResolution.crsName} → WGS84]`, 'info');
        geojsonFeatures = features.map(feat => {
          return {
            ...feat,
            geometry: this._reprojectGeometry(feat.geometry, crsResolution.transformFn)
          };
        });
      }

      const geojson = {
        type: 'FeatureCollection',
        features: geojsonFeatures
      };

      const layerName = customName || ((GIS.FileHandler && GIS.FileHandler.stripExtension)
        ? GIS.FileHandler.stripExtension(fileName)
        : fileName.replace(/\.[^/.]+$/, ''));

      const isShohan = !!(GIS.ShohanStyle && GIS.ShohanStyle.isShohan(layerName, fileOrUrl, sampleFeature));
      const isRinpan = !isShohan && !!(GIS.RinpanStyle && GIS.RinpanStyle.isRinpan(layerName, fileOrUrl, sampleFeature));

      // FGB専用 Canvas レンダラー（DOM要素の大量生成を防ぎ数万件でも高速・滑らかに描画）
      const canvasRenderer = L.canvas({ padding: 0.5 });

      // Leaflet GeoJSON レイヤーの生成
      const leafletLayer = L.geoJSON(geojson, {
        renderer: canvasRenderer,
        style: (feature) => {
          if (isShohan && GIS.ShohanStyle) {
            return GIS.ShohanStyle.getStyle();
          }
          if (isRinpan && GIS.RinpanStyle) {
            return GIS.RinpanStyle.getStyle();
          }
          return this._getStyle(feature);
        },
        pointToLayer: (feature, latlng) => this._pointToLayer(feature, latlng),
        onEachFeature: (feature, layer) => {
          if (isShohan && GIS.ShohanStyle) {
            const no = GIS.ShohanStyle.getShohanNo(feature);
            layer._fgbLabelNo = no;
            return; // tooltip, popup は特に不要（動的制御で表示）
          }
          if (isRinpan && GIS.RinpanStyle) {
            const no = GIS.RinpanStyle.getRinpanNo(feature);
            layer._fgbLabelNo = no;
            return; // tooltip, popup は特に不要（動的制御で表示）
          }
          this._onEachFeature(feature, layer);
        }
      });

      // 動的パフォーマンス制御（Canvas表示制御および画面内・高ズーム時のみラベル生成）
      this._setupDynamicPerformanceController(leafletLayer, isShohan, isRinpan, canvasRenderer, features.length);

      GIS.AppState.addLayer({
        name: layerName,
        type: 'fgb',
        layer: leafletLayer,
        rawGeoJSON: geojson,
        file: isFile ? fileOrUrl : null,
        isLayerSet: isLayerSet || layerName === '森林計画'
      });

      // 読み込んだレイヤーの範囲にズーム
      setTimeout(() => {
        try {
          const bounds = leafletLayer.getBounds();
          if (bounds && bounds.isValid()) {
            GIS.AppState.map.fitBounds(bounds, { padding: [40, 40] });
            return;
          }
        } catch (_) {}

        try {
          const fallbackBounds = L.latLngBounds();
          leafletLayer.eachLayer(layer => {
            if (typeof layer.getBounds === 'function') {
              fallbackBounds.extend(layer.getBounds());
            } else if (typeof layer.getLatLng === 'function') {
              fallbackBounds.extend(layer.getLatLng());
            }
          });
          if (fallbackBounds.isValid()) {
            GIS.AppState.map.fitBounds(fallbackBounds, { padding: [40, 40] });
          }
        } catch (_) {}
      }, 0);

      const crsSuffix = crsResolution.needsReproject ? ` [${crsResolution.crsName} → WGS84]` : '';
      GIS.UI.showToast(`✅ FlatGeobuf読み込み完了${crsSuffix}: ${features.length}フィーチャ (${fileName})`, 'success');
    },

    /**
     * ヘッダーメタデータおよびサンプル座標から座標変換関数を決定
     * @param {object} headerMeta
     * @param {object} sampleFeature
     * @returns {{ needsReproject: boolean, crsName: string, transformFn?: Function }}
     */
    _resolveTransformer(headerMeta, sampleFeature) {
      const crs = headerMeta ? headerMeta.crs : null;
      let epsgCode = crs ? (crs.code || crs.srid) : null;
      const wkt = crs ? (crs.wkt || '') : '';
      const crsName = crs ? (crs.name || '') : '';

      // WKTからEPSGコードの検出フォールバック
      if (!epsgCode && wkt) {
        const idMatch = wkt.match(/ID\["EPSG",\s*(\d+)\]/i) || wkt.match(/AUTHORITY\["EPSG",\s*"(\d+)"\]/i);
        if (idMatch) {
          epsgCode = parseInt(idMatch[1], 10);
        }
      }

      // 1. EPSG:4326 または JGD2000/2011 経緯度（4612 / 6668）: 再投影不要
      if (epsgCode === 4326 || epsgCode === 4612 || epsgCode === 6668) {
        return {
          needsReproject: false,
          crsName: crsName || `EPSG:${epsgCode}`
        };
      }

      // 2. Web Mercator (EPSG:3857 / 900913)
      if (epsgCode === 3857 || epsgCode === 900913 || /Pseudo-Mercator|Web\s*Mercator/i.test(wkt) || /Pseudo-Mercator/i.test(crsName)) {
        return {
          needsReproject: true,
          crsName: 'Web Mercator (EPSG:3857)',
          transformFn: (x, y) => window.proj4('EPSG:3857', 'EPSG:4326', [x, y])
        };
      }

      // 3. 日本の平面直交座標系（JGD2011: 6669〜6687、JGD2000: 2443〜2461）
      if (epsgCode && ((epsgCode >= 6669 && epsgCode <= 6687) || (epsgCode >= 2443 && epsgCode <= 2461))) {
        const zoneInfo = this._registerJgdPlaneZone(epsgCode);
        if (zoneInfo) {
          return {
            needsReproject: true,
            crsName: `${zoneInfo.name} (EPSG:${epsgCode})`,
            transformFn: (x, y) => window.proj4(zoneInfo.epsgStr, 'EPSG:4326', [x, y])
          };
        }
      }

      // 4. その他のWKTが定義されている場合
      if (wkt && window.proj4) {
        try {
          const customId = 'FGB_WKT_' + Math.floor(Math.random() * 10000);
          window.proj4.defs(customId, wkt);
          return {
            needsReproject: true,
            crsName: crsName || 'WKT定義座標系',
            transformFn: (x, y) => window.proj4(customId, 'EPSG:4326', [x, y])
          };
        } catch (err) {
          console.warn('[FlatGeobufHandler] Failed to register WKT to proj4:', err);
        }
      }

      // 5. ヘッダー情報不備時の座標値ヒューリスティック判定
      const sampleCoord = this._getFirstCoord(sampleFeature ? sampleFeature.geometry : null);
      if (sampleCoord) {
        const [x, y] = sampleCoord;

        // 経緯度の範囲内 (-180 <= x <= 180, -90 <= y <= 90) ならそのまま
        if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
          return { needsReproject: false, crsName: 'WGS84 (経緯度)' };
        }

        // Webメルカトル値判定 (|X| > 1,000,000 かつ 変換後の緯度経度が有効範囲)
        if (window.proj4) {
          const [lon, lat] = window.proj4('EPSG:3857', 'EPSG:4326', [x, y]);
          if (isFinite(lon) && isFinite(lat) && lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180) {
            return {
              needsReproject: true,
              crsName: 'Web Mercator (自動推定 EPSG:3857)',
              transformFn: (px, py) => window.proj4('EPSG:3857', 'EPSG:4326', [px, py])
            };
          }

          // 平面直交座標系（能登・北陸周辺の第7系をはじめ各系を自動探索）
          for (let z = 1; z <= 19; z++) {
            const code = 6668 + z;
            const zoneInfo = this._registerJgdPlaneZone(code);
            if (zoneInfo) {
              const [plon, plat] = window.proj4(zoneInfo.epsgStr, 'EPSG:4326', [x, y]);
              // 日本本土・周辺域（緯度20〜46、経度122〜154）に収まるか
              if (plat >= 20 && plat <= 46 && plon >= 122 && plon <= 154) {
                return {
                  needsReproject: true,
                  crsName: `${zoneInfo.name} (自動推定 EPSG:${code})`,
                  transformFn: (px, py) => window.proj4(zoneInfo.epsgStr, 'EPSG:4326', [px, py])
                };
              }
            }
          }
        }
      }

      // フォールバック: そのまま
      return { needsReproject: false, crsName: 'WGS84 (デフォルト)' };
    },

    /**
     * ジオメトリ内の最初の座標ペアを取得
     */
    _getFirstCoord(geom) {
      if (!geom || !geom.coordinates) return null;
      let c = geom.coordinates;
      while (Array.isArray(c) && Array.isArray(c[0])) {
        c = c[0];
      }
      if (Array.isArray(c) && typeof c[0] === 'number') {
        return [c[0], c[1]];
      }
      return null;
    },

    /**
     * GeoJSONジオメトリを再帰的に再投影
     */
    _reprojectGeometry(geom, transformFn) {
      if (!geom) return geom;
      if (geom.type === 'GeometryCollection') {
        return {
          ...geom,
          geometries: (geom.geometries || []).map(g => this._reprojectGeometry(g, transformFn))
        };
      }
      return {
        ...geom,
        coordinates: this._reprojectCoords(geom.coordinates, transformFn)
      };
    },

    /**
     * 座標配列を再帰的に変換
     */
    _reprojectCoords(coords, transformFn) {
      if (!Array.isArray(coords)) return coords;
      if (typeof coords[0] === 'number') {
        const [lon, lat] = transformFn(coords[0], coords[1]);
        if (coords.length > 2) {
          return [lon, lat, coords[2]];
        }
        return [lon, lat];
      }
      return coords.map(c => this._reprojectCoords(c, transformFn));
    },

    /**
     * ポリゴン・ラインのスタイル
     */
    _getStyle(feature) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._getStyle === 'function') {
        const base = GIS.GeoJsonHandler._getStyle(feature);
        const p = feature.properties || {};
        return {
          ...base,
          color: p.stroke || p['marker-color'] || '#0284c7', // シアン/ブルー系
          fillColor: p.fill || p.stroke || '#0ea5e9'
        };
      }
      return {
        color: '#0284c7',
        fillColor: '#0ea5e9',
        weight: 2,
        opacity: 0.9,
        fillOpacity: 0.35
      };
    },

    /**
     * ポイントをサークルマーカーに変換
     */
    _pointToLayer(feature, latlng) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._pointToLayer === 'function') {
        return GIS.GeoJsonHandler._pointToLayer(feature, latlng);
      }
      return L.circleMarker(latlng, {
        radius: 8,
        fillColor: '#0ea5e9',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.9
      });
    },

    /**
     * 各フィーチャにポップアップを設定
     */
    _onEachFeature(feature, layer) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._onEachFeature === 'function') {
        GIS.GeoJsonHandler._onEachFeature(feature, layer);
      }
    },

    /**
     * FGB高負荷防止: Canvas表示制御および画面内・高ズーム時のみの動的ラベル制御
     * @param {L.GeoJSON} leafletLayer
     * @param {boolean} isShohan
     * @param {boolean} isRinpan
     * @param {L.Canvas} canvasRenderer
     * @param {number} featureCount
     */
    _setupDynamicPerformanceController(leafletLayer, isShohan, isRinpan, canvasRenderer, featureCount) {
      const map = GIS.AppState ? GIS.AppState.map : null;
      if (!map) return;

      const minLabelZoom = isShohan
        ? ((GIS.ShohanStyle && GIS.ShohanStyle.MIN_ZOOM_LABEL) || 17)
        : ((GIS.RinpanStyle && GIS.RinpanStyle.MIN_ZOOM) || 15);

      const minPolygonZoom = isShohan
        ? ((GIS.ShohanStyle && GIS.ShohanStyle.MIN_ZOOM_POLYGON) || 16)
        : 1;

      const updateState = () => {
        if (!map || !map.hasLayer(leafletLayer)) return;
        const currentZoom = map.getZoom();
        const container = (canvasRenderer && typeof canvasRenderer.getContainer === 'function')
          ? canvasRenderer.getContainer()
          : (canvasRenderer ? canvasRenderer._container : null);

        // 1. ポリゴン自体の表示・非表示ガード（小班のみ低ズームで非表示、一般FGB・林班は全ズームで常時表示）
        const shouldShowPolygons = (currentZoom >= minPolygonZoom);
        if (container) {
          container.style.display = shouldShowPolygons ? '' : 'none';
        }

        // 2. ラベルの動的生成・破棄（画面内かつ高ズーム時のみ配置してDOM肥大化を防止）
        if (!isShohan && !isRinpan) return;

        if (currentZoom < minLabelZoom) {
          leafletLayer.eachLayer(layer => {
            if (layer.getTooltip && layer.getTooltip()) {
              layer.unbindTooltip();
            }
          });
          return;
        }

        const mapBounds = map.getBounds();
        leafletLayer.eachLayer(layer => {
          if (!layer._fgbLabelNo) return;

          let isVisible = false;
          if (typeof layer.getBounds === 'function') {
            const b = layer.getBounds();
            isVisible = b && b.isValid() && mapBounds.intersects(b);
          } else if (typeof layer.getLatLng === 'function') {
            const ll = layer.getLatLng();
            isVisible = ll && mapBounds.contains(ll);
          }

          if (isVisible) {
            if (!layer.getTooltip || !layer.getTooltip()) {
              if (isShohan && GIS.ShohanStyle) {
                GIS.ShohanStyle.applyCenterLabel(layer, layer._fgbLabelNo);
              } else if (isRinpan && GIS.RinpanStyle) {
                GIS.RinpanStyle.applyCenterLabel(layer, layer._fgbLabelNo);
              }
            }
          } else {
            if (layer.getTooltip && layer.getTooltip()) {
              layer.unbindTooltip();
            }
          }
        });
      };

      map.on('moveend zoomend', updateState);
      leafletLayer.on('remove', () => {
        map.off('moveend zoomend', updateState);
        leafletLayer.eachLayer(l => {
          if (l.getTooltip && l.getTooltip()) l.unbindTooltip();
        });
      });

      // 初回実行（レイヤー追加後に反映）
      setTimeout(updateState, 300);
    },

    /**
     * UIイベント初期化
     */
    init() {
      const btn = document.getElementById('btn-load-rinpan');
      if (btn) {
        btn.addEventListener('click', async () => {
          try {
            btn.disabled = true;
            if (window.rinpanFgbBase64) {
              const bin = atob(window.rinpanFgbBase64);
              const u8 = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) {
                u8[i] = bin.charCodeAt(i);
              }
              const file = new File([u8], 'rinpan.fgb', { type: 'application/octet-stream' });
              await this.load(file, '森林計画', true);
            } else {
              await this.load('data/rinpan.fgb', '森林計画', true);
            }
          } catch (err) {
            console.error('[FlatGeobufHandler] Error loading rinpan.fgb:', err);
            if (GIS.UI && GIS.UI.showToast) {
              GIS.UI.showToast(`❌ 森林計画データの読み込みエラー: ${err.message}`, 'error');
            }
          } finally {
            btn.disabled = false;
          }
        });
      }
    }
  };

  // DOMロード後にUIイベントを初期化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => GIS.FlatGeobufHandler.init());
  } else {
    GIS.FlatGeobufHandler.init();
  }

})(window.GIS = window.GIS || {});
