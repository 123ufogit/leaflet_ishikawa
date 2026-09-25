/**
 * polygonDrawer.js - 地図上での作図・計測モジュール（ポイント・ライン・ポリゴン対応）
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.PolygonDrawer = {
    _isDrawing: false,
    _currentMode: 'polygon', // 'point' | 'line' | 'polygon'
    _points: [],             // L.LatLng の配列
    _tempMarkers: [],        // 頂点マーカーの配列
    _tempPolyline: null,     // 描画中ガイドライン
    _kinkLayers: [],         // 自己交差警告マーカー
    _pointCount: 0,
    _lineCount: 0,
    _polygonCount: 0,
    _sessionCount: 0,
    _sessionLayerId: null,
    _sessionFeatureGroup: null,
    _sessionGeoJSON: null,
    _wasPanelCollapsed: false,
    _wasLegendHidden: true,
    _toolbarInitialized: false,

    /**
     * 作図のON/OFFをトグルする
     * @param {'point' | 'line' | 'polygon'} [mode] 
     */
    toggleDrawing(mode) {
      if (this._isDrawing) {
        if (mode && mode !== this._currentMode) {
          this.switchMode(mode);
        } else {
          this.stopDrawing();
        }
      } else {
        this.startDrawing(mode || this._currentMode || 'polygon');
      }
    },

    /**
     * 作図モードを切り替える（描画中ツールバーから呼び出し）
     * @param {'point' | 'line' | 'polygon'} newMode 
     */
    switchMode(newMode) {
      if (newMode === this._currentMode && this._isDrawing) return;

      this._clearTempLayers();
      this._points = [];
      this._currentMode = newMode;

      this._updateToolbarUI();

      const modeLabels = { point: 'ポイント', line: 'ライン', polygon: 'ポリゴン' };
      GIS.UI.showToast(`✏️ 【${modeLabels[newMode] || newMode}】作図モードに切り替えました`, 'info');
    },

    /**
     * 作図を開始する（操作パネル・凡例を自動で閉じ、新規セッションを開始）
     * @param {'point' | 'line' | 'polygon'} mode 
     */
    startDrawing(mode = 'polygon') {
      const map = GIS.AppState.map;
      if (!map) return;

      this._isDrawing = true;
      this._currentMode = mode;
      this._points = [];
      this._tempMarkers = [];
      this._clearKinkMarkers();

      // 新しい作図セッションの初期化（このセッションで作成した図形は1つのレイヤに統合）
      this._sessionLayerId = null;
      this._sessionFeatureGroup = null;
      this._sessionGeoJSON = null;

      // 操作パネルを自動的に閉じる（折りたたむ）
      if (GIS.FloatingPanel) {
        this._wasPanelCollapsed = !!GIS.FloatingPanel._collapsed;
        GIS.FloatingPanel.collapse();
      }

      // 凡例パネル（能登半島LiDAR凡例等）を自動的に閉じる
      const legendPanel = document.getElementById('noto-legend-panel');
      if (legendPanel) {
        this._wasLegendHidden = legendPanel.classList.contains('hidden');
        legendPanel.classList.add('hidden');
      }

      // パネルボタンのアクティブ表示
      const panelBtn = document.getElementById('btn-toggle-drawing');
      if (panelBtn) panelBtn.classList.add('active');

      // 画面上部ツールバーの初期化＆表示
      this._showToolbar(true);
      map.getContainer().style.cursor = 'crosshair';

      this._onMapClick = this._handleMapClick.bind(this);
      this._onMapDblClick = this._handleMapDblClick.bind(this);
      this._onMouseMove = this._handleMouseMove.bind(this);
      this._onKeyDown = this._handleKeyDown.bind(this);

      map.on('click', this._onMapClick);
      map.on('dblclick', this._onMapDblClick);
      map.on('mousemove', this._onMouseMove);
      document.addEventListener('keydown', this._onKeyDown);
    },

    /**
     * 描画を終了する（操作パネル・凡例を自動で復帰）
     */
    stopDrawing() {
      if (!this._isDrawing) return;
      const map = GIS.AppState.map;

      this._isDrawing = false;
      this._showToolbar(false);

      // パネルボタンのアクティブ解除
      const panelBtn = document.getElementById('btn-toggle-drawing');
      if (panelBtn) panelBtn.classList.remove('active');

      if (map) {
        map.getContainer().style.cursor = '';
        map.off('click', this._onMapClick);
        map.off('dblclick', this._onMapDblClick);
        map.off('mousemove', this._onMouseMove);
      }
      document.removeEventListener('keydown', this._onKeyDown);

      this._clearTempLayers();
      this._points = [];

      // 操作パネルを自動的に開く（作成されたレイヤーを確認できるように展開）
      if (GIS.FloatingPanel) {
        GIS.FloatingPanel.expand();
      }

      // 凡例パネルが以前開いていた場合（またはLiDARレイヤ表示中）に復帰
      const legendPanel = document.getElementById('noto-legend-panel');
      if (legendPanel && !this._wasLegendHidden) {
        legendPanel.classList.remove('hidden');
      } else if (GIS.NotoLidarHandler && GIS.NotoLidarHandler.updateLegend) {
        GIS.NotoLidarHandler.updateLegend();
      }

      // セッション終了
      this._sessionLayerId = null;
      this._sessionFeatureGroup = null;
      this._sessionGeoJSON = null;
    },

    /**
     * 画面上部作図ツールバーの表示/非表示制御
     * @param {boolean} show 
     */
    _showToolbar(show) {
      const toolbar = document.getElementById('drawing-toolbar');
      const basemapToolbar = document.getElementById('basemap-toolbar');

      if (show) {
        if (toolbar) {
          toolbar.classList.remove('hidden');
          this._initToolbarEvents();
          this._updateToolbarUI();
        }
        // ベースマップツールバーを一時的に非表示にして干渉を防止
        if (basemapToolbar) {
          basemapToolbar.style.opacity = '0';
          basemapToolbar.style.pointerEvents = 'none';
        }
      } else {
        if (toolbar) {
          toolbar.classList.add('hidden');
        }
        // ベースマップツールバーを復帰
        if (basemapToolbar) {
          basemapToolbar.style.opacity = '';
          basemapToolbar.style.pointerEvents = '';
        }
      }
    },

    /**
     * ツールバー内のクリックイベントを初期化
     */
    _initToolbarEvents() {
      if (this._toolbarInitialized) return;
      this._toolbarInitialized = true;

      const toolbar = document.getElementById('drawing-toolbar');
      if (!toolbar) return;

      // モード切り替えボタン
      const modeBtns = toolbar.querySelectorAll('.draw-mode-btn');
      modeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
          const mode = btn.dataset.mode;
          if (mode) this.switchMode(mode);
        });
      });

      // 終了ボタン
      const closeBtn = document.getElementById('btn-cancel-draw');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          this.stopDrawing();
          GIS.UI.showToast('ℹ️ 作図を終了しました', 'info');
        });
      }
    },

    /**
     * ツールバーの選択状態とヒント表示を更新
     */
    _updateToolbarUI() {
      const toolbar = document.getElementById('drawing-toolbar');
      if (!toolbar) return;

      // モードボタンのアクティブクラス更新
      const modeBtns = toolbar.querySelectorAll('.draw-mode-btn');
      modeBtns.forEach(btn => {
        if (btn.dataset.mode === this._currentMode) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // ヒントテキストの更新
      const hint = document.getElementById('drawing-toolbar-hint');
      if (hint) {
        if (this._currentMode === 'point') {
          hint.textContent = '地図上をクリックしてピンを配置 (Escで終了)';
        } else if (this._currentMode === 'line') {
          hint.textContent = 'クリックで頂点追加 / ダブルクリックまたはEnterで確定 (Escで終了)';
        } else if (this._currentMode === 'profile') {
          hint.textContent = '📈 断面図作成：2点以上クリックしてダブルクリックまたはEnterで確定 (Escで終了)';
        } else {
          hint.textContent = 'クリックで頂点追加 / 始点クリックまたはEnterで確定 (Escで終了)';
        }
      }
    },

    /**
     * マウスクリック時の処理
     */
    _handleMapClick(e) {
      const map = GIS.AppState.map;
      const latlng = e.latlng;

      // 1. ポイント作図モードの場合: クリック位置に即座に配置して確定
      if (this._currentMode === 'point') {
        this._finishPoint(latlng);
        return;
      }

      // 2. ポリゴン作図モードで始点付近クリック時の確定判定
      if (this._currentMode === 'polygon' && this._points.length >= 3) {
        const firstPt = this._points[0];
        const distPx = map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(firstPt));
        if (distPx < 15) { // 15px以内なら閉じて確定
          this._finishPolygon();
          return;
        }
      }

      // 3. 頂点追加 (ラインまたはポリゴン)
      this._points.push(latlng);

      const marker = L.circleMarker(latlng, {
        radius: 5,
        color: '#00d7ff',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2
      }).addTo(map);

      // ポリゴンモードの始点クリックで確定できるようにイベント登録
      if (this._currentMode === 'polygon' && this._points.length === 1) {
        marker.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (this._points.length >= 3) {
            this._finishPolygon();
          }
        });
      }

      this._tempMarkers.push(marker);
      this._updatePolyline();
    },

    /**
     * ダブルクリックで描画確定
     */
    _handleMapDblClick(e) {
      L.DomEvent.stopPropagation(e);
      if (this._currentMode === 'line' || this._currentMode === 'profile') {
        if (this._points.length >= 2) {
          this._finishLine();
        } else {
          GIS.UI.showToast('⚠️ ライン作成には2点以上必要です', 'warn');
        }
      } else if (this._currentMode === 'polygon') {
        if (this._points.length >= 3) {
          this._finishPolygon();
        } else {
          GIS.UI.showToast('⚠️ ポリゴン作成には3点以上必要です', 'warn');
        }
      }
    },

    /**
     * マウス移動時のガイドライン更新
     */
    _handleMouseMove(e) {
      if (this._points.length === 0 || this._currentMode === 'point') return;
      const map = GIS.AppState.map;
      const guidePoints = [...this._points, e.latlng];

      if (!this._tempPolyline) {
        this._tempPolyline = L.polyline(guidePoints, {
          color: '#00d7ff',
          weight: 2.5,
          dashArray: '5, 5',
          pane: 'overlayLinePane'
        }).addTo(map);
      } else {
        this._tempPolyline.setLatLngs(guidePoints);
      }
    },

    /**
     * キーボード入力（Escでキャンセル、Enterで確定）
     */
    _handleKeyDown(e) {
      if (e.key === 'Escape') {
        this.stopDrawing();
        GIS.UI.showToast('ℹ️ 作図を終了しました', 'info');
      } else if (e.key === 'Enter') {
        if (this._currentMode === 'line' || this._currentMode === 'profile') {
          if (this._points.length >= 2) {
            this._finishLine();
          } else {
            GIS.UI.showToast('⚠️ ライン作成には2点以上必要です', 'warn');
          }
        } else if (this._currentMode === 'polygon') {
          if (this._points.length >= 3) {
            this._finishPolygon();
          } else {
            GIS.UI.showToast('⚠️ ポリゴン作成には3つ以上の点が必要です', 'warn');
          }
        }
      }
    },

    /**
     * ガイドラインの更新
     */
    _updatePolyline() {
      const map = GIS.AppState.map;
      if (this._points.length < 2) return;

      if (!this._tempPolyline) {
        this._tempPolyline = L.polyline(this._points, {
          color: '#00d7ff',
          weight: 2.5,
          pane: 'overlayLinePane'
        }).addTo(map);
      } else {
        this._tempPolyline.setLatLngs(this._points);
      }
    },

    /**
     * 作図セッションに図形（Leaflet レイヤーおよび GeoJSON Feature）を追加・統合する
     * 一旦ツールを開始してから終了するまでに作成した図形は全て同じレイヤとして扱う
     * @param {L.Layer} leafletLayer
     * @param {object} featureObj
     * @param {string} defaultName
     * @returns {string} layerId
     */
    _addFeatureToSession(leafletLayer, featureObj, defaultName) {
      if (!this._sessionLayerId || !this._sessionFeatureGroup) {
        this._sessionFeatureGroup = L.featureGroup();
        this._sessionGeoJSON = {
          type: 'FeatureCollection',
          features: []
        };
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const sessionName = `作図 ${y}${m}${d}_${h}${min}`;

        this._sessionLayerId = GIS.AppState.addLayer({
          name: sessionName,
          type: 'geojson',
          layer: this._sessionFeatureGroup,
          file: null,
          rawGeoJSON: this._sessionGeoJSON,
          editable: true,
          isDrawn: true
        });

        if (!this._appStateListenersBound && GIS.AppState) {
          this._appStateListenersBound = true;
          GIS.AppState.on('layerRemoved', ({ id }) => {
            if (id === this._sessionLayerId) {
              this._sessionLayerId = null;
              this._sessionFeatureGroup = null;
              this._sessionGeoJSON = null;
            }
          });
          GIS.AppState.on('allLayersCleared', () => {
            this._sessionLayerId = null;
            this._sessionFeatureGroup = null;
            this._sessionGeoJSON = null;
          });
        }
      }

      // レイヤーグループに追加
      this._sessionFeatureGroup.addLayer(leafletLayer);

      // GeoJSON フィーチャ配列に追記
      this._sessionGeoJSON.features.push(featureObj);

      // AppState レイヤーエントリの rawGeoJSON を更新
      const entry = GIS.AppState.layers.get(this._sessionLayerId);
      if (entry) {
        entry.rawGeoJSON = this._sessionGeoJSON;
      }

      return this._sessionLayerId;
    },

    /**
     * ポイント描画の確定
     * @param {L.LatLng} latlng 
     */
    _finishPoint(latlng) {
      this._pointCount++;
      const pointName = `手描きポイント ${this._pointCount}`;

      const pointMarker = L.circleMarker(latlng, {
        radius: 7,
        color: '#00d7ff',
        fillColor: '#ffffff',
        fillOpacity: 0.95,
        weight: 2.5,
        pane: 'overlayPointPane'
      });

      const popupHtml = `
        <div class="geojson-popup">
          <strong class="popup-name">📍 ${pointName}</strong>
          <div style="font-family: monospace; font-size: 11.5px; margin-top: 6px; color: var(--color-text-sub); line-height: 1.6;">
            緯度: ${latlng.lat.toFixed(6)}°<br>
            経度: ${latlng.lng.toFixed(6)}°
          </div>
        </div>
      `;
      pointMarker.bindPopup(popupHtml, { maxWidth: 280 });

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [latlng.lng, latlng.lat]
        },
        properties: {
          name: pointName,
          isDrawn: true
        }
      };

      this._addFeatureToSession(pointMarker, feature, pointName);

      GIS.UI.showToast(`✅ 『${pointName}』を作図レイヤーに追加しました`, 'success');

      // 続けて配置できるようにヒントを更新
      const hint = document.getElementById('drawing-toolbar-hint');
      if (hint) {
        hint.textContent = '続けてクリックしてポイントを追加、または [✕ 終了]';
      }
    },

    /**
     * ライン描画の確定
     */
    _finishLine() {
      if (this._points.length < 2) {
        GIS.UI.showToast('⚠️ ライン作成には2点以上必要です', 'warn');
        return;
      }

      this._lineCount++;
      const lineName = `手描きライン ${this._lineCount}`;

      // 総延長の計算
      let totalDist = 0;
      for (let i = 0; i < this._points.length - 1; i++) {
        totalDist += this._points[i].distanceTo(this._points[i + 1]);
      }
      const formattedDist = totalDist >= 1000
        ? `${(totalDist / 1000).toFixed(2)} km (${Math.round(totalDist).toLocaleString()} m)`
        : `${totalDist.toFixed(1)} m`;

      const lineLayer = L.polyline(this._points, {
        color: '#00d7ff',
        weight: 3.5,
        opacity: 0.9,
        pane: 'overlayLinePane'
      });

      const popupHtml = `
        <div class="geojson-popup">
          <strong class="popup-name">📏 ${lineName}</strong>
          <div class="popup-measure-badge popup-distance" style="margin-top:6px;">
            📏 延長: <strong>${formattedDist}</strong>
          </div>
          <div style="font-size: 11px; color: var(--color-text-sub); margin-top: 4px;">
            頂点数: ${this._points.length} 点
          </div>
        </div>
      `;
      lineLayer.bindPopup(popupHtml, { maxWidth: 300 });

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: this._points.map(pt => [pt.lng, pt.lat])
        },
        properties: {
          name: lineName,
          distance: totalDist,
          formattedDistance: formattedDist,
          isDrawn: true
        }
      };

      this._addFeatureToSession(lineLayer, feature, lineName);

      // 断面図モードの場合は標高断面図を自動生成
      if (this._currentMode === 'profile' && GIS.ElevationHandler) {
        GIS.ElevationHandler.generateProfileFromLine(this._points, lineName);
      }

      this._clearTempLayers();
      this._points = [];

      GIS.UI.showToast(`✅ 『${lineName}』(延長: ${formattedDist}) を作図レイヤーに追加しました`, 'success');

      const hint = document.getElementById('drawing-toolbar-hint');
      if (hint) {
        hint.textContent = this._currentMode === 'profile'
          ? '続けて断面図ラインを作図、または [✕ 終了]'
          : '続けてラインを作図、または [✕ 終了]';
      }
    },

    /**
     * ポリゴン描画を確定し、AppState に登録する
     */
    _finishPolygon() {
      if (this._points.length < 3) {
        GIS.UI.showToast('⚠️ ポリゴン作成には3点以上必要です', 'warn');
        return;
      }

      this._polygonCount++;
      const polygonName = `手描きマスク ${this._polygonCount}`;

      // GeoJSON データ構造の構築 ([lng, lat] 順)
      const coordinates = this._points.map(pt => [pt.lng, pt.lat]);
      // 閉路を保証
      if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
          coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
        coordinates.push([...coordinates[0]]);
      }

      // 自己交差チェック
      const { hasKinks, kinkPoints } = this._checkSelfIntersection(coordinates);

      // Leaflet Polygon レイヤーの作成
      const polygonLayer = L.polygon(this._points, {
        color: hasKinks ? '#ef4444' : '#00d7ff',
        weight: 2.5,
        fillColor: hasKinks ? '#ef4444' : '#00d7ff',
        fillOpacity: hasKinks ? 0.12 : 0,
        pane: 'overlayPolygonPane'
      });

      // 面積計算
      const area = this._calcPolygonArea(coordinates);
      const formattedArea = area >= 10000 
        ? `${(area / 10000).toFixed(2)} ha (${Math.round(area).toLocaleString()} m²)`
        : `${area.toFixed(1)} m²`;

      // ポップアップ HTML の生成
      const createPopupHtml = () => {
        let zoningHtml = '';
        if (GIS.ZoningAnalysis) {
          const geom = { type: 'Polygon', coordinates: [coordinates] };
          zoningHtml = GIS.ZoningAnalysis.analyzePolygonZoning(geom, area);
        }

        const warnBadgeHtml = hasKinks
          ? `<div class="popup-warn-badge">⚠️ 自己交差ポリゴン（交差あり）<br><small style="font-weight:normal;opacity:0.85;">面積・マスク計算に誤差が生じる可能性があります</small></div>`
          : '';

        return `
          <div class="geojson-popup">
            <strong class="popup-name">✏️ ${polygonName}</strong>
            ${warnBadgeHtml}
            <div class="popup-measure-badge popup-area" style="margin-top:6px;">
              📐 面積: <strong>${formattedArea}</strong>
            </div>
            ${zoningHtml}
          </div>
        `;
      };

      polygonLayer.bindPopup(createPopupHtml, { maxWidth: 320 });

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [coordinates]
        },
        properties: {
          name: polygonName,
          area: area,
          formattedArea: formattedArea,
          isSelfIntersecting: hasKinks,
          isDrawn: true
        }
      };

      // AppState の現在セッションレイヤーに追加
      const newLayerId = this._addFeatureToSession(polygonLayer, feature, polygonName);

      this._clearTempLayers();
      this._points = [];

      // 自己交差が発生している場合の警告通知＆交差ポイント表示
      if (hasKinks) {
        this._showKinkMarkers(kinkPoints);
        GIS.UI.showToast(
          `⚠️ 警告: 作図したポリゴンに【自己交差】が検出されました！交差箇所をご確認ください。`,
          'warn'
        );
      } else {
        GIS.UI.showToast(`✅ 『${polygonName}』(面積: ${formattedArea}) を作図レイヤーに追加しました`, 'success');
      }

      const hint = document.getElementById('drawing-toolbar-hint');
      if (hint) {
        hint.textContent = '続けてポリゴンを作図、または [✕ 終了]';
      }
    },

    /**
     * ポリゴンの自己交差（Self-intersection）を検出する
     * @param {Array<[number, number]>} coordinates - 閉じた [lng, lat] 配列
     * @returns {{ hasKinks: boolean, kinkPoints: Array<[number, number]> }} [lat, lng] の交点
     */
    _checkSelfIntersection(coordinates) {
      // 1. Turf.js の turf.kinks を優先使用
      try {
        if (window.turf && typeof window.turf.kinks === 'function' && typeof window.turf.polygon === 'function') {
          const poly = turf.polygon([coordinates]);
          const kinks = turf.kinks(poly);
          if (kinks && kinks.features && kinks.features.length > 0) {
            const kinkPoints = kinks.features.map(f => [
              f.geometry.coordinates[1], // lat
              f.geometry.coordinates[0]  // lng
            ]);
            return { hasKinks: true, kinkPoints };
          }
          return { hasKinks: false, kinkPoints: [] };
        }
      } catch (err) {
        console.warn('[PolygonDrawer] turf.kinks check error, trying fallback algorithm:', err);
      }

      // 2. フォールバック: 2次元線分の交差判定（自己交差検出アルゴリズム）
      const pts = coordinates.slice(0, -1);
      const n = pts.length;
      const kinkPoints = [];
      if (n < 4) return { hasKinks: false, kinkPoints: [] };

      for (let i = 0; i < n; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue; // 隣接する辺同士は頂点を共有するためスキップ
          const p3 = pts[j];
          const p4 = pts[(j + 1) % n];
          const intersect = this._lineSegmentsIntersect(p1, p2, p3, p4);
          if (intersect) {
            kinkPoints.push([intersect[1], intersect[0]]); // [lat, lng]
          }
        }
      }

      return { hasKinks: kinkPoints.length > 0, kinkPoints };
    },

    /**
     * 2つの線分 p1-p2 と p3-p4 の交差判定
     */
    _lineSegmentsIntersect(p1, p2, p3, p4) {
      const ccw = (A, B, C) => (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
      if (ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4)) {
        const x = (p1[0] + p2[0] + p3[0] + p4[0]) / 4;
        const y = (p1[1] + p2[1] + p3[1] + p4[1]) / 4;
        return [x, y];
      }
      return null;
    },

    /**
     * 自己交差点に警告マーカーを表示する
     * @param {Array<[number, number]>} kinkPoints - [lat, lng]
     */
    _showKinkMarkers(kinkPoints) {
      this._clearKinkMarkers();
      const map = GIS.AppState.map;
      if (!map || !kinkPoints || kinkPoints.length === 0) return;

      kinkPoints.forEach(([lat, lng]) => {
        const marker = L.circleMarker([lat, lng], {
          radius: 8,
          color: '#ef4444',
          fillColor: '#fee2e2',
          fillOpacity: 0.9,
          weight: 3
        }).addTo(map);

        marker.bindPopup(`
          <div style="font-size: 12px; color: #ef4444; font-weight: bold; padding: 4px;">
            ⚠️ 自己交差点<br>
            <span style="font-size: 11px; color: var(--color-text-sub); font-weight: normal;">
              座標: ${lat.toFixed(5)}, ${lng.toFixed(5)}
            </span>
          </div>
        `);

        this._kinkLayers.push(marker);
      });

      // 8秒後に自己交差ハイライトを自動クリア
      setTimeout(() => this._clearKinkMarkers(), 8000);
    },

    /**
     * 自己交差警告マーカーを消去
     */
    _clearKinkMarkers() {
      const map = GIS.AppState.map;
      if (map && this._kinkLayers.length) {
        this._kinkLayers.forEach(m => map.removeLayer(m));
      }
      this._kinkLayers = [];
    },

    /**
     * 一時描画エレメントの消去
     */
    _clearTempLayers() {
      const map = GIS.AppState.map;
      if (!map) return;

      this._tempMarkers.forEach(m => map.removeLayer(m));
      this._tempMarkers = [];

      if (this._tempPolyline) {
        map.removeLayer(this._tempPolyline);
        this._tempPolyline = null;
      }
    },

    /**
     * ポリゴンリング（[lon,lat] 配列）の球面積を計算する（m²）
     */
    _calcPolygonArea(ring) {
      if (!ring || ring.length < 3) return 0;
      const R = 6378137; // 地球半径 (m)
      const rad = d => (d * Math.PI) / 180;
      let area = 0;
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % n];
        area += rad(p2[0] - p1[0]) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])));
      }
      area = Math.abs((area * R * R) / 2.0);
      return area;
    }
  };

  // エイリアス
  GIS.DrawingTools = GIS.PolygonDrawer;

})(window.GIS = window.GIS || {});
