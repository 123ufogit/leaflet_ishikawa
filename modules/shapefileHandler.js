/**
 * shapefileHandler.js - シェープファイル (.shp, .dbf, .shx, .prj, .cpg, .zip) の読み込みとLeaflet表示
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  /** shpjs ライブラリの CDN URL */
  const SHPJS_CDN = 'https://cdn.jsdelivr.net/npm/shpjs/dist/shp.js';

  let shpReady = false;
  let shpLoading = false;
  let shpCallbacks = [];

  GIS.ShapefileHandler = {

    /**
     * shpjs ライブラリを動的に読み込む
     * @returns {Promise<void>}
     */
    _ensureShp() {
      if (shpReady || typeof window.shp === 'function') {
        shpReady = true;
        return Promise.resolve();
      }
      if (shpLoading) {
        return new Promise((resolve, reject) => shpCallbacks.push({ resolve, reject }));
      }

      shpLoading = true;
      return new Promise((resolve, reject) => {
        shpCallbacks.push({ resolve, reject });
        const script = document.createElement('script');
        script.src = SHPJS_CDN;
        script.onload = () => {
          shpReady = true;
          shpLoading = false;
          shpCallbacks.forEach(cb => cb.resolve());
          shpCallbacks = [];
        };
        script.onerror = () => {
          shpLoading = false;
          const err = new Error('Shapefile解析ライブラリ(shpjs)の読み込みに失敗しました。');
          shpCallbacks.forEach(cb => cb.reject(err));
          shpCallbacks = [];
          reject(err);
        };
        document.head.appendChild(script);
      });
    },

    /**
     * ZIP圧縮されたシェープファイルを読み込む
     * @param {File} file
     */
    async loadZip(file) {
      if (!file) return;

      GIS.UI.showToast(`🔷 Shapefile (ZIP) 準備中: ${file.name}`, 'info');
      await this._ensureShp();

      if (typeof window.shp !== 'function') {
        throw new Error('Shapefile パーサーが見つかりません。');
      }

      GIS.UI.showToast(`🔷 Shapefileを展開・解析中: ${file.name}`, 'info');

      const buffer = await file.arrayBuffer();
      let result;
      try {
        result = await window.shp(buffer);
      } catch (e) {
        console.error('[ShapefileHandler] ZIP parse error:', e);
        throw new Error(`Shapefile ZIPの解析に失敗しました: ${e.message}`);
      }

      if (!result) {
        throw new Error('ZIP内に有効なShapefileが見つかりませんでした。');
      }

      // 単一または複数のGeoJSONコレクションを処理
      const collections = Array.isArray(result) ? result : [result];
      let totalFeatures = 0;

      for (const geojson of collections) {
        const count = (geojson.features || []).length;
        if (count === 0) continue;

        totalFeatures += count;
        const layerName = geojson.fileName || (GIS.FileHandler && GIS.FileHandler.stripExtension
          ? GIS.FileHandler.stripExtension(file.name)
          : file.name.replace(/\.[^/.]+$/, ''));

        this._addGeoJsonLayer(geojson, layerName, file);
      }

      if (totalFeatures === 0) {
        throw new Error('Shapefile内にフィーチャが見つかりませんでした。');
      }

      GIS.UI.showToast(`✅ Shapefile読み込み完了: ${totalFeatures}フィーチャ (${file.name})`, 'success');
    },

    /**
     * ベース名でグループ化されたシェープファイル構成要素を読み込む
     * @param {{ baseName: string, shp: File, dbf?: File, shx?: File, prj?: File, cpg?: File }} group
     */
    async loadGroup(group) {
      if (!group || !group.shp) return;

      GIS.UI.showToast(`🔷 Shapefile 準備中: ${group.baseName}`, 'info');
      await this._ensureShp();

      if (typeof window.shp !== 'function') {
        throw new Error('Shapefile パーサーが見つかりません。');
      }

      GIS.UI.showToast(`🔷 Shapefile 解析中: ${group.baseName}`, 'info');

      const shpBuffer = await group.shp.arrayBuffer();
      let dbfBuffer = group.dbf ? await group.dbf.arrayBuffer() : null;
      let prjText = group.prj ? await group.prj.text() : null;
      let cpgText = group.cpg ? (await group.cpg.text()).trim() : null;

      let geojson = null;

      // shpjs のオブジェクト引数形式でパース
      const parseWithOptions = async (encoding) => {
        const payload = {
          shp: shpBuffer
        };
        if (dbfBuffer) payload.dbf = dbfBuffer;
        if (prjText) payload.prj = prjText;
        if (encoding) payload.cpg = encoding;
        return await window.shp(payload);
      };

      try {
        // CPG指定がある場合はそれを使用、無ければ Shift-JIS をまず試行（日本のGISデータ対応）
        const initialEncoding = cpgText || 'Shift-JIS';
        geojson = await parseWithOptions(initialEncoding);
      } catch (e1) {
        console.warn('[ShapefileHandler] Initial parse failed, retrying with UTF-8:', e1);
        try {
          geojson = await parseWithOptions('UTF-8');
        } catch (e2) {
          // DBFが問題の場合はジオメトリ単体パースを試行
          if (window.shp.parseShp) {
            console.warn('[ShapefileHandler] Retrying geometry-only parse:', e2);
            try {
              const geometries = window.shp.parseShp(shpBuffer, prjText);
              geojson = {
                type: 'FeatureCollection',
                features: (geometries || []).map(g => ({
                  type: 'Feature',
                  geometry: g,
                  properties: {}
                }))
              };
            } catch (e3) {
              throw new Error(`Shapefileの解析に失敗しました: ${e3.message}`);
            }
          } else {
            throw new Error(`Shapefileの解析に失敗しました: ${e2.message}`);
          }
        }
      }

      if (!geojson) {
        throw new Error('Shapefileのデータを生成できませんでした。');
      }

      const collections = Array.isArray(geojson) ? geojson : [geojson];
      let totalFeatures = 0;

      for (const fc of collections) {
        const count = (fc.features || []).length;
        if (count === 0) continue;
        totalFeatures += count;
        const layerName = fc.fileName || group.baseName;
        this._addGeoJsonLayer(fc, layerName, group.shp);
      }

      if (totalFeatures === 0) {
        throw new Error('Shapefile内にフィーチャが見つかりませんでした。');
      }

      GIS.UI.showToast(`✅ Shapefile読み込み完了: ${totalFeatures}フィーチャ (${group.baseName})`, 'success');
    },

    /**
     * GeoJSONデータをLeafletレイヤーとして登録し地図に追加
     */
    _addGeoJsonLayer(geojson, layerName, sourceFile) {
      const sampleFeature = (geojson.features || [])[0];
      const isShohan = !!(GIS.ShohanStyle && GIS.ShohanStyle.isShohan(layerName, sourceFile, sampleFeature));
      const isRinpan = !isShohan && !!(GIS.RinpanStyle && GIS.RinpanStyle.isRinpan(layerName, sourceFile, sampleFeature));

      const leafletLayer = L.geoJSON(geojson, {
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
            GIS.ShohanStyle.applyCenterLabel(layer, no);
            return; // tooltip, popup は特に不要（表示のみ）
          }
          if (isRinpan && GIS.RinpanStyle) {
            const no = GIS.RinpanStyle.getRinpanNo(feature);
            GIS.RinpanStyle.applyCenterLabel(layer, no);
            return; // tooltip, popup は特に不要（表示のみ）
          }
          this._onEachFeature(feature, layer);
        }
      });

      GIS.AppState.addLayer({
        name: layerName,
        type: 'shp',
        layer: leafletLayer,
        rawGeoJSON: geojson,
        file: sourceFile
      });

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
    },

    /**
     * スタイル（アンバー / オレンジ系アクセント）
     */
    _getStyle(feature) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._getStyle === 'function') {
        const base = GIS.GeoJsonHandler._getStyle(feature);
        const p = feature.properties || {};
        return {
          ...base,
          color: p.stroke || p['marker-color'] || '#d97706',
          fillColor: p.fill || p.stroke || '#f59e0b'
        };
      }
      return {
        color: '#d97706',
        fillColor: '#f59e0b',
        weight: 2,
        opacity: 0.9,
        fillOpacity: 0.35
      };
    },

    /**
     * ポイントマーカー
     */
    _pointToLayer(feature, latlng) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._pointToLayer === 'function') {
        return GIS.GeoJsonHandler._pointToLayer(feature, latlng);
      }
      return L.circleMarker(latlng, {
        radius: 8,
        fillColor: '#f59e0b',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.9
      });
    },

    /**
     * ポップアップ
     */
    _onEachFeature(feature, layer) {
      if (GIS.GeoJsonHandler && typeof GIS.GeoJsonHandler._onEachFeature === 'function') {
        GIS.GeoJsonHandler._onEachFeature(feature, layer);
      }
    }
  };

})(window.GIS = window.GIS || {});
