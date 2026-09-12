/**
 * geometryEditor.js - ポイント・ライン・ポリゴンのドラッグ＆頂点編集機能および新規図形追加・別ファイル保存
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  GIS.GeometryEditor = {
    activeLayerId: null,
    activeLayerEntry: null,
    activeTargetFeature: null,
    selectedFeature: null,
    _vertexMarkers: [],
    _midpointMarkers: [],
    _originalCoords: [],
    _originalCoordsMap: null,
    _isEditing: false,
    _beforeUnloadHandler: null,
    _globalEditorKeyBound: false,

    // 新規図形追加関連の状態
    _isAddingShape: false,
    _addingShapeType: null, // 'point' | 'line' | 'polygon'
    _addPoints: [],
    _addTempMarkers: [],
    _addTempPolyline: null,
    _addedLayersInCurrentSession: [],
    _deletedLayersInCurrentSession: [],
    _originalRawGeoJSONBackup: null,

    get isEditing() {
      return this._isEditing;
    },

    init: function () {
      this._bindBannerEvents();
      this._beforeUnloadHandler = (e) => {
        if (this._isEditing) {
          e.preventDefault();
          e.returnValue = '';
        }
      };

      // AppState初期化完了後にレイヤー監視を開始
      if (GIS.AppState && GIS.AppState.layers) {
        this._bindAppStateLayers();
      } else {
        const checkInterval = setInterval(() => {
          if (GIS.AppState && GIS.AppState.layers) {
            clearInterval(checkInterval);
            this._bindAppStateLayers();
          }
        }, 100);
      }
    },

    _bindBannerEvents: function () {
      const addBtn = document.getElementById('btn-editor-add');
      const addMenu = document.getElementById('editor-add-menu');
      const deleteShapeBtn = document.getElementById('btn-editor-delete-shape');
      const saveBtn = document.getElementById('btn-editor-save');
      const cancelBtn = document.getElementById('btn-editor-cancel');

      if (addBtn) {
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (addMenu) {
            addMenu.classList.toggle('hidden');
          }
        });
      }

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.editor-add-dropdown-container')) {
          this._closeAddMenu();
        }
      });

      if (addMenu) {
        addMenu.querySelectorAll('.editor-add-item').forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const geomType = item.dataset.geomType;
            if (geomType) {
              this.startAddShape(geomType);
            }
          });
        });
      }

      if (deleteShapeBtn) {
        deleteShapeBtn.addEventListener('click', () => {
          this.deleteSelectedShape();
        });
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          this.finishEdit(true);
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          this.cancelEdit();
        });
      }

      // Delete/Backspace キーで選択図形を削除
      if (!this._globalEditorKeyBound) {
        this._globalEditorKeyBound = true;
        document.addEventListener('keydown', (e) => {
          if (!this._isEditing || this._isAddingShape) return;
          if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
          if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selectedFeature) {
              e.preventDefault();
              this.deleteSelectedShape();
            }
          }
        });
      }
    },

    _closeAddMenu: function () {
      const addMenu = document.getElementById('editor-add-menu');
      if (addMenu) addMenu.classList.add('hidden');
    },

    _bindAppStateLayers: function () {
      if (!GIS.AppState) return;

      // 既存の登録済みレイヤーに長押しトリガーを設定
      if (GIS.AppState.layers) {
        GIS.AppState.layers.forEach(entry => {
          this.bindLayerFeatures(entry);
        });
      }

      // 新規追加されるレイヤーを監視
      GIS.AppState.on('layerAdded', (entry) => {
        this.bindLayerFeatures(entry);
      });
    },

    /**
     * レイヤー内のフィーチャに2秒長押し編集トリガーを設定
     * @param {object} entry - AppStateのlayerEntry
     */
    bindLayerFeatures: function (entry) {
      if (!entry || !entry.layer) return;

      // 編集対象外のレイヤー種別（配信タイル、GeoTIFF、画像、明示的editable:false、県営林レイヤ等）を除外
      if (entry.editable === false || entry.name === '県営林' ||
          (GIS.ForestRoadHandler && entry.id === GIS.ForestRoadHandler.keneirinLayerId)) {
        return;
      }
      if (entry.type === 'tile' || entry.type === 'geotiff' || entry.type === 'image' || entry.type === 'vectorgrid') {
        return;
      }
      if (entry.layer instanceof L.TileLayer || entry.layer instanceof L.GridLayer || entry.layer instanceof L.ImageOverlay) {
        return;
      }

      const layer = entry.layer;

      // 1. FeatureGroup / LayerGroup / GeoJSONの場合
      if (layer.eachLayer && typeof layer.eachLayer === 'function') {
        layer.eachLayer(subLayer => {
          this._attachLongPressToFeature(subLayer, entry.id);
        });
        if (layer.on) {
          layer.on('layeradd', (e) => {
            if (e.layer) this._attachLongPressToFeature(e.layer, entry.id);
          });
        }
      }

      // 2. 単体レイヤー（Marker, CircleMarker, Polyline, Polygonなど）の場合
      if (typeof layer.on === 'function') {
        this._attachLongPressToFeature(layer, entry.id);
      }
    },

    /**
     * 個別フィーチャに2秒長押し（ロングクリック/ロングタップ）で編集を開始するリスナーを設定
     * @param {L.Layer} featureLayer
     * @param {string} entryId
     */
    _attachLongPressToFeature: function (featureLayer, entryId) {
      if (!featureLayer || featureLayer._geomEditLongPressBound) return;

      // FeatureGroup等の入れ子の場合は再帰的に処理（CircleMarker/Marker/Polyline/Polygonは除外）
      if (featureLayer.eachLayer && typeof featureLayer.eachLayer === 'function' &&
          !(featureLayer instanceof L.Polyline || featureLayer instanceof L.Polygon ||
            featureLayer instanceof L.Marker || featureLayer instanceof L.CircleMarker)) {
        featureLayer.eachLayer(sub => this._attachLongPressToFeature(sub, entryId));
        if (featureLayer.on) {
          featureLayer.on('layeradd', (e) => {
            if (e.layer) this._attachLongPressToFeature(e.layer, entryId);
          });
        }
        featureLayer._geomEditLongPressBound = true;
        return;
      }

      if (typeof featureLayer.on !== 'function') return;
      featureLayer._geomEditLongPressBound = true;

      let pressTimer = null;
      let isLongPressed = false;
      let startX = 0;
      let startY = 0;
      const LONG_PRESS_DURATION = 2000; // 2秒以上

      const cancelPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      const handleStart = (e) => {
        // 既に編集中の場合やマウス右クリック等は無視
        if (this._isEditing) return;
        if (GIS.AppState && GIS.AppState.layers) {
          const ent = GIS.AppState.layers.get(entryId);
          if (ent && (ent.editable === false || ent.name === '県営林' ||
              (GIS.ForestRoadHandler && ent.id === GIS.ForestRoadHandler.keneirinLayerId))) {
            return;
          }
        }
        const orig = e.originalEvent || e;
        if (orig.button !== undefined && orig.button !== 0) return; // 左クリックのみ

        isLongPressed = false;
        startX = orig.clientX || (orig.touches && orig.touches[0] ? orig.touches[0].clientX : 0);
        startY = orig.clientY || (orig.touches && orig.touches[0] ? orig.touches[0].clientY : 0);

        pressTimer = setTimeout(() => {
          isLongPressed = true;
          cancelPress();

          // 通常クリックによるポップアップ表示を抑止して閉じる
          if (typeof featureLayer.closePopup === 'function') {
            featureLayer.closePopup();
          }
          if (GIS.AppState && GIS.AppState.map) {
            GIS.AppState.map.closePopup();
          }

          // 編集モードを起動
          this.startEdit(entryId, featureLayer);
        }, LONG_PRESS_DURATION);
      };

      const handleMove = (e) => {
        if (!pressTimer) return;
        const orig = e.originalEvent || e;
        const curX = orig.clientX || (orig.touches && orig.touches[0] ? orig.touches[0].clientX : 0);
        const curY = orig.clientY || (orig.touches && orig.touches[0] ? orig.touches[0].clientY : 0);
        if (Math.abs(curX - startX) > 10 || Math.abs(curY - startY) > 10) {
          cancelPress();
        }
      };

      const handleEnd = () => {
        cancelPress();
      };

      const handleClick = (e) => {
        // 2秒長押し直後のクリックイベント、または編集中レイヤーの通常クリックによるポップアップを抑止
        if (isLongPressed || (this._isEditing && this.activeLayerId === entryId)) {
          if (e.originalEvent) {
            if (typeof e.originalEvent.preventDefault === 'function') e.originalEvent.preventDefault();
            if (typeof e.originalEvent.stopPropagation === 'function') e.originalEvent.stopPropagation();
          }
          L.DomEvent.stop(e);
          if (typeof featureLayer.closePopup === 'function') {
            featureLayer.closePopup();
          }
          if (GIS.AppState && GIS.AppState.map) {
            GIS.AppState.map.closePopup();
          }
          // 編集中レイヤーの通常クリック時は対象図形を選択
          if (this._isEditing && this.activeLayerId === entryId && !isLongPressed && !this._isAddingShape) {
            this.selectFeature(featureLayer);
          }
          isLongPressed = false;
        }
      };

      featureLayer.on('mousedown', handleStart);
      featureLayer.on('mousemove', handleMove);
      featureLayer.on('mouseup', handleEnd);
      featureLayer.on('click', handleClick);

      // タッチデバイス（スマートフォン等）対応
      featureLayer.on('touchstart', handleStart);
      featureLayer.on('touchmove', handleMove);
      featureLayer.on('touchend', handleEnd);
      featureLayer.on('touchcancel', handleEnd);
    },

    /**
     * 指定したレイヤー（およびフィーチャ）のジオメトリ編集モードを開始
     * @param {string} layerId
     * @param {L.Layer} [targetFeature]
     */
    startEdit: function (layerId, targetFeature = null) {
      if (!GIS.AppState) return;
      const entry = GIS.AppState.layers.get(layerId);
      if (!entry || !entry.layer) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('⚠️ 編集対象のレイヤーが見つかりません', 'warning');
        }
        return;
      }

      // 県営林など編集不可レイヤーの場合は拒否
      if (entry.editable === false || entry.name === '県営林' ||
          (GIS.ForestRoadHandler && entry.id === GIS.ForestRoadHandler.keneirinLayerId)) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('ℹ️ 『県営林』は参照専用レイヤーのため編集対象外です', 'info');
        }
        return;
      }

      // 既に別のレイヤーを編集中の場合は終了（変更は破棄）
      if (this._isEditing) {
        this.finishEdit(false);
      }

      this.activeLayerId = layerId;
      this.activeLayerEntry = entry;
      this._isEditing = true;

      // セッション追加・削除レイヤーリストの初期化およびrawGeoJSONバックアップ
      this._addedLayersInCurrentSession = [];
      this._deletedLayersInCurrentSession = [];
      this._originalRawGeoJSONBackup = entry.rawGeoJSON ? JSON.parse(JSON.stringify(entry.rawGeoJSON)) : null;

      // ページ離脱・リロード防止リスナーの登録
      if (this._beforeUnloadHandler) {
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
      }

      // バックアップ用オリジナル座標を保持（レイヤー全体）
      this._backupOriginalCoords(entry.layer);

      // 上部編集バナーを表示
      this._showBanner(entry.name || 'レイヤー');

      // 初期の選択対象図形を決定して編集状態を開始
      let initialFeature = targetFeature;
      if (!initialFeature || initialFeature === entry.layer) {
        if (entry.layer && typeof entry.layer.getLayers === 'function') {
          const subs = entry.layer.getLayers();
          initialFeature = subs.length > 0 ? subs[0] : null;
        } else {
          initialFeature = entry.layer;
        }
      }
      this.selectFeature(initialFeature);

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`✏️ 『${entry.name}』の編集モードを開始しました`, 'info');
      }
    },

    _cloneLatLngs: function (coords) {
      if (!coords) return coords;
      if (Array.isArray(coords)) {
        return coords.map(c => this._cloneLatLngs(c));
      }
      if (typeof coords.lat === 'number' && typeof coords.lng === 'number') {
        return L.latLng(coords.lat, coords.lng);
      }
      return coords;
    },

    _backupOriginalCoords: function (layer) {
      this._originalCoordsMap = new Map();
      if (!layer) return;
      if (layer.eachLayer && typeof layer.eachLayer === 'function') {
        layer.eachLayer(sub => {
          if (typeof sub.getLatLng === 'function' && typeof sub.getLatLngs !== 'function') {
            this._originalCoordsMap.set(sub, L.latLng(sub.getLatLng()));
          } else if (typeof sub.getLatLngs === 'function') {
            this._originalCoordsMap.set(sub, this._cloneLatLngs(sub.getLatLngs()));
          }
        });
      } else {
        if (typeof layer.getLatLng === 'function' && typeof layer.getLatLngs !== 'function') {
          this._originalCoordsMap.set(layer, L.latLng(layer.getLatLng()));
        } else if (typeof layer.getLatLngs === 'function') {
          this._originalCoordsMap.set(layer, this._cloneLatLngs(layer.getLatLngs()));
        }
      }
    },

    _restoreOriginalCoords: function () {
      if (!this._originalCoordsMap) return;
      this._originalCoordsMap.forEach((origCoords, layer) => {
        if (!origCoords || !layer) return;
        if (typeof layer.setLatLng === 'function' && typeof layer.getLatLngs !== 'function') {
          layer.setLatLng(origCoords);
          if (layer.feature && layer.feature.geometry) {
            layer.feature.geometry.coordinates = [origCoords.lng, origCoords.lat];
          }
        } else if (typeof layer.setLatLngs === 'function') {
          layer.setLatLngs(origCoords);
          this._syncFeatureCoordinates(layer);
        }
      });
    },

    _showBanner: function (layerName) {
      const banner = document.getElementById('geometry-editor-banner');
      const label = document.getElementById('editor-banner-title');
      if (banner) {
        if (label) label.textContent = `✏️ 編集モード中：${layerName}`;
        banner.classList.remove('hidden');
      }
      this._updateDeleteButtonState();
    },

    _hideBanner: function () {
      const banner = document.getElementById('geometry-editor-banner');
      if (banner) banner.classList.add('hidden');
      this._updateDeleteButtonState();
    },

    _updateBannerHint: function (type) {
      const hint = document.querySelector('.editor-banner-hint');
      if (!hint) return;
      if (type === 'point') {
        hint.textContent = 'ポイントをドラッグして移動 / 「🗑️ 削除」で図形削除';
      } else if (type === 'polygon') {
        hint.textContent = '頂点をドラッグして移動、中間ハンドルで追加 / 「🗑️ 削除」で図形削除';
      } else if (type === 'polyline' || type === 'line') {
        hint.textContent = '頂点をドラッグして移動、中間ハンドルで追加 / 「🗑️ 削除」で図形削除';
      } else {
        hint.textContent = '図形をクリックして選択、頂点をドラッグして移動 / 「🗑️ 削除」で図形削除';
      }
    },

    _updateDeleteButtonState: function () {
      const delBtn = document.getElementById('btn-editor-delete-shape');
      if (!delBtn) return;
      if (this._isEditing && this.selectedFeature) {
        delBtn.disabled = false;
        delBtn.title = '選択中の図形をレイヤーから削除 (Deleteキー)';
      } else {
        delBtn.disabled = true;
        delBtn.title = '削除する図形を選択してください';
      }
    },

    _getFeatureGeomType: function (feature) {
      if (!feature) return null;
      if (feature.feature && feature.feature.geometry) {
        const t = feature.feature.geometry.type;
        if (t === 'Point' || t === 'MultiPoint') return 'point';
        if (t === 'LineString' || t === 'MultiLineString') return 'line';
        if (t === 'Polygon' || t === 'MultiPolygon') return 'polygon';
      }
      if (feature instanceof L.Polygon) return 'polygon';
      if (feature instanceof L.Polyline) return 'line';
      if (feature instanceof L.Marker || feature instanceof L.CircleMarker) return 'point';
      return 'shape';
    },

    selectFeature: function (feature) {
      if (!this._isEditing) return;

      this.selectedFeature = feature;
      this.activeTargetFeature = feature;
      this._clearHandles();

      if (feature) {
        this._setupLayerEditing(feature);
        this._updateDeleteButtonState();
        const geomType = this._getFeatureGeomType(feature);
        const typeNames = { point: 'ポイント', line: 'ライン', polygon: 'ポリゴン', shape: '図形' };
        const typeName = typeNames[geomType] || '図形';
        this._setBannerHint(`【${typeName}】選択中：頂点をドラッグして移動 / 「🗑️ 削除」で図形削除`);
      } else {
        this._updateDeleteButtonState();
        this._setBannerHint('図形をクリックして選択するか、「＋ 新規」から新しい図形を追加してください');
      }
    },

    deleteSelectedShape: function () {
      if (!this._isEditing || !this.activeLayerEntry) return;

      const target = this.selectedFeature;
      if (!target) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('⚠️ 削除対象の図形が選択されていません', 'warning');
        }
        return;
      }

      const entry = this.activeLayerEntry;
      const map = GIS.AppState.map;

      // 1. ハンドル類をクリア
      this._clearHandles();

      // 2. キャンセル時の復元用に削除追跡リストに記録
      const parentGroup = (entry.layer && typeof entry.layer.hasLayer === 'function' && entry.layer.hasLayer(target))
        ? entry.layer
        : (map && map.hasLayer(target) ? map : null);

      this._deletedLayersInCurrentSession.push({
        layer: target,
        parent: parentGroup,
        feature: target.feature || null
      });

      // 3. レイヤーグループおよびマップから削除
      if (entry.layer && typeof entry.layer.removeLayer === 'function') {
        entry.layer.removeLayer(target);
      }
      if (map && map.hasLayer(target)) {
        map.removeLayer(target);
      }

      // 4. rawGeoJSON からもフィーチャを削除
      if (entry.rawGeoJSON && entry.rawGeoJSON.features && target.feature) {
        const idx = entry.rawGeoJSON.features.indexOf(target.feature);
        if (idx !== -1) {
          entry.rawGeoJSON.features.splice(idx, 1);
        }
      }

      // 5. 新規追加セッションリストにあればそこからも除外
      if (this._addedLayersInCurrentSession) {
        const addIdx = this._addedLayersInCurrentSession.indexOf(target);
        if (addIdx !== -1) {
          this._addedLayersInCurrentSession.splice(addIdx, 1);
        }
      }

      // 6. レイヤーを未保存状態にマーク
      entry.isUnsaved = true;
      if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }

      // 7. 次の選択対象を探す
      this.selectedFeature = null;
      this.activeTargetFeature = null;

      let nextFeature = null;
      if (entry.layer && typeof entry.layer.getLayers === 'function') {
        const remaining = entry.layer.getLayers();
        if (remaining.length > 0) {
          nextFeature = remaining[remaining.length - 1];
        }
      }

      if (nextFeature) {
        this.selectFeature(nextFeature);
      } else {
        this._updateDeleteButtonState();
        this._setBannerHint('図形がすべて削除されました。「＋ 新規」から新しい図形を追加できます');
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('🗑️ 選択した図形を削除しました（未保存）', 'info');
      }
    },

    _syncFeatureCoordinates: function (pathLayer) {
      if (!pathLayer || !pathLayer.feature || !pathLayer.feature.geometry) return;
      const geomType = pathLayer.feature.geometry.type;
      const latlngs = pathLayer.getLatLngs();
      if (geomType === 'LineString') {
        const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
        pathLayer.feature.geometry.coordinates = pts.map(p => [p.lng, p.lat]);
      } else if (geomType === 'Polygon') {
        let ring = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
        if (Array.isArray(ring[0])) ring = ring[0];
        const coords = ring.map(p => [p.lng, p.lat]);
        if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
          coords.push([...coords[0]]);
        }
        pathLayer.feature.geometry.coordinates = [coords];
      }
    },

    _setupLayerEditing: function (feature) {
      const map = GIS.AppState.map;
      if (!map || !feature) return;

      // 1. 単一ポイント（Marker, CircleMarker等）の場合
      if (typeof feature.getLatLng === 'function' && typeof feature.getLatLngs !== 'function') {
        this._setupPointEditing(feature);
        this._updateBannerHint('point');
        return;
      }

      // 2. 単体 Polyline または Polygon の場合
      if (typeof feature.getLatLngs === 'function') {
        this._createHandlesForPath(feature);
        this._updateBannerHint(feature instanceof L.Polygon ? 'polygon' : 'polyline');
        return;
      }

      // 3. FeatureGroup / LayerGroup / GeoJSONの場合
      if (feature.getLayers && typeof feature.getLayers === 'function') {
        let hasPoint = false;
        let hasPath = false;
        feature.getLayers().forEach(subLayer => {
          if (typeof subLayer.getLatLng === 'function' && typeof subLayer.getLatLngs !== 'function') {
            this._setupPointEditing(subLayer);
            hasPoint = true;
          } else if (typeof subLayer.getLatLngs === 'function') {
            this._createHandlesForPath(subLayer);
            hasPath = true;
          }
        });
        if (hasPoint && !hasPath) {
          this._updateBannerHint('point');
        } else {
          this._updateBannerHint('path');
        }
      }
    },

    /**
     * ポイント（Marker, CircleMarker等）用の編集ハンドル設置
     * @param {L.Layer} pointLayer
     */
    _setupPointEditing: function (pointLayer) {
      const map = GIS.AppState.map;
      if (!map || !pointLayer || typeof pointLayer.getLatLng !== 'function') return;

      // L.Marker 等で dragging が利用可能な場合は有効化
      if (pointLayer.dragging && typeof pointLayer.dragging.enable === 'function') {
        pointLayer.dragging.enable();
      }

      // CircleMarkerやMarkerの上に高視認性ドラッグハンドルを配置
      const latlng = pointLayer.getLatLng();
      const vMarker = L.marker([latlng.lat, latlng.lng], {
        draggable: true,
        icon: L.divIcon({
          className: 'geom-editor-vertex-handle geom-editor-point-handle',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        }),
        zIndexOffset: 2000
      }).addTo(map);

      // ハンドルドラッグ時に元のポイント位置およびFeatureジオメトリ座標を同期更新
      vMarker.on('drag', (e) => {
        const newPos = e.target ? e.target.getLatLng() : (e.latlng || vMarker.getLatLng());
        pointLayer.setLatLng(newPos);
        if (pointLayer.feature && pointLayer.feature.geometry) {
          pointLayer.feature.geometry.coordinates = [newPos.lng, newPos.lat];
        }
      });

      vMarker.on('dragend', (e) => {
        const newPos = e.target ? e.target.getLatLng() : (e.latlng || vMarker.getLatLng());
        pointLayer.setLatLng(newPos);
        if (pointLayer.feature && pointLayer.feature.geometry) {
          pointLayer.feature.geometry.coordinates = [newPos.lng, newPos.lat];
        }
      });

      // ポイント自体がドラッグされた場合（L.Marker）もハンドルの位置を追従
      if (pointLayer.on) {
        pointLayer.on('drag', (e) => {
          const pos = pointLayer.getLatLng();
          vMarker.setLatLng(pos);
        });
      }

      this._vertexMarkers.push(vMarker);
    },

    /**
     * Polyline / Polygon 用の頂点ハンドル・中間ハンドルの生成
     */
    _createHandlesForPath: function (pathLayer) {
      const map = GIS.AppState.map;
      const isPolygon = (pathLayer instanceof L.Polygon) || (pathLayer._rings && pathLayer._rings.length > 0 && pathLayer.options && pathLayer.options.fill);

      let latlngs = pathLayer.getLatLngs();
      // マルチポリゴン等のネスト解消
      let isMulti = Array.isArray(latlngs[0]) && (latlngs[0][0] instanceof L.LatLng || Array.isArray(latlngs[0][0]));
      let ring = isMulti ? latlngs[0] : latlngs;
      if (Array.isArray(ring[0]) && ring[0][0] instanceof L.LatLng) ring = ring[0];

      const updateHandles = () => {
        this._clearHandles();
        const currentRing = ring;

        currentRing.forEach((ll, idx) => {
          // 頂点ハンドル
          const vMarker = L.marker([ll.lat, ll.lng], {
            draggable: true,
            icon: L.divIcon({
              className: 'geom-editor-vertex-handle',
              iconSize: [12, 12],
              iconAnchor: [6, 6]
            }),
            zIndexOffset: 2000
          }).addTo(map);

          vMarker.on('drag', (e) => {
            const newPos = e.target ? e.target.getLatLng() : (e.latlng || vMarker.getLatLng());
            currentRing[idx] = newPos;
            pathLayer.setLatLngs(latlngs);
            this._syncFeatureCoordinates(pathLayer);
            this._updateMidpoints(pathLayer, currentRing, updateHandles);
          });

          vMarker.on('dragend', () => {
            this._syncFeatureCoordinates(pathLayer);
            updateHandles();
          });

          // 右クリックまたはAlt+クリックで頂点削除
          vMarker.on('contextmenu', (e) => {
            L.DomEvent.stopPropagation(e);
            L.DomEvent.preventDefault(e);
            if (currentRing.length > (isPolygon ? 3 : 2)) {
              currentRing.splice(idx, 1);
              pathLayer.setLatLngs(latlngs);
              this._syncFeatureCoordinates(pathLayer);
              updateHandles();
              if (GIS.UI && GIS.UI.showToast) {
                GIS.UI.showToast('🗑 頂点を削除しました', 'info');
              }
            } else {
              if (GIS.UI && GIS.UI.showToast) {
                GIS.UI.showToast(`⚠️ これ以上頂点を削除できません（最小${isPolygon ? 3 : 2}点）`, 'warning');
              }
            }
          });

          this._vertexMarkers.push(vMarker);
        });

        this._updateMidpoints(pathLayer, currentRing, updateHandles);
      };

      updateHandles();
    },

    _updateMidpoints: function (pathLayer, ring, refreshCallback) {
      const map = GIS.AppState.map;
      const isPolygon = (pathLayer instanceof L.Polygon);

      // 既存中間ハンドル削除
      this._midpointMarkers.forEach(m => map.removeLayer(m));
      this._midpointMarkers = [];

      const count = isPolygon ? ring.length : ring.length - 1;
      for (let i = 0; i < count; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % ring.length];
        const midLat = (p1.lat + p2.lat) / 2;
        const midLng = (p1.lng + p2.lng) / 2;

        const mMarker = L.marker([midLat, midLng], {
          draggable: true,
          opacity: 0.65,
          icon: L.divIcon({
            className: 'geom-editor-midpoint-handle',
            iconSize: [10, 10],
            iconAnchor: [5, 5]
          }),
          zIndexOffset: 1500
        }).addTo(map);

        // 中間ハンドルをドラッグした瞬間に新しい頂点として挿入
        mMarker.on('dragstart', () => {
          ring.splice(i + 1, 0, L.latLng(midLat, midLng));
        });

        mMarker.on('drag', (e) => {
          const newPos = e.target ? e.target.getLatLng() : (e.latlng || mMarker.getLatLng());
          ring[i + 1] = newPos;
          pathLayer.setLatLngs(pathLayer.getLatLngs());
          this._syncFeatureCoordinates(pathLayer);
        });

        mMarker.on('dragend', () => {
          this._syncFeatureCoordinates(pathLayer);
          refreshCallback();
        });

        this._midpointMarkers.push(mMarker);
      }
    },

    _clearHandles: function () {
      const map = GIS.AppState.map;
      if (!map) return;

      this._vertexMarkers.forEach(m => map.removeLayer(m));
      this._vertexMarkers = [];

      this._midpointMarkers.forEach(m => map.removeLayer(m));
      this._midpointMarkers = [];
    },

    // ==============================================================
    // 新規図形（ポイント、ライン、ポリゴン）の追加処理
    // ==============================================================

    /**
     * 新規図形追加モードを開始
     * @param {'point' | 'line' | 'polygon'} type
     */
    startAddShape: function (type) {
      if (!this._isEditing || !this.activeLayerEntry) return;

      this._closeAddMenu();
      this._stopAddShape(); // 既存の作図モードを初期化

      const map = GIS.AppState.map;
      if (!map) return;

      this._isAddingShape = true;
      this._addingShapeType = type;
      this._addPoints = [];
      this._addTempMarkers = [];
      this._addTempPolyline = null;

      const addBtn = document.getElementById('btn-editor-add');
      if (addBtn) addBtn.classList.add('active');

      map.getContainer().style.cursor = 'crosshair';

      const typeNames = { point: 'ポイント', line: 'ライン', polygon: 'ポリゴン' };
      if (type === 'point') {
        this._setBannerHint('📍 地図上をクリックして新規ポイントを配置 (Escでキャンセル)');
      } else if (type === 'line') {
        this._setBannerHint('📏 クリックで頂点追加 / ダブルクリックまたはEnterで確定 (Escでキャンセル)');
      } else {
        this._setBannerHint('🔷 クリックで頂点追加 / 始点クリックまたはEnterで確定 (Escでキャンセル)');
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`✏️ 【新規${typeNames[type]}】追加モードを開始しました`, 'info');
      }

      this._onAddMapClick = (e) => this._handleAddMapClick(e);
      this._onAddMapDblClick = (e) => this._handleAddMapDblClick(e);
      this._onAddMouseMove = (e) => this._handleAddMouseMove(e);
      this._onAddKeyDown = (e) => this._handleAddKeyDown(e);

      map.on('click', this._onAddMapClick);
      map.on('dblclick', this._onAddMapDblClick);
      map.on('mousemove', this._onAddMouseMove);
      document.addEventListener('keydown', this._onAddKeyDown);
    },

    _stopAddShape: function () {
      if (!this._isAddingShape) return;
      const map = GIS.AppState.map;

      this._isAddingShape = false;
      this._addingShapeType = null;
      this._addPoints = [];

      const addBtn = document.getElementById('btn-editor-add');
      if (addBtn) addBtn.classList.remove('active');

      if (map) {
        map.getContainer().style.cursor = '';
        if (this._onAddMapClick) map.off('click', this._onAddMapClick);
        if (this._onAddMapDblClick) map.off('dblclick', this._onAddMapDblClick);
        if (this._onAddMouseMove) map.off('mousemove', this._onAddMouseMove);
      }
      if (this._onAddKeyDown) {
        document.removeEventListener('keydown', this._onAddKeyDown);
      }

      this._clearAddTempLayers();

      // 通常の編集ヒントに復元
      if (this.activeTargetFeature) {
        this._setupLayerEditing(this.activeTargetFeature);
      } else {
        this._setBannerHint('頂点をドラッグして移動、中間ハンドルで追加、右クリックで削除');
      }
    },

    _setBannerHint: function (text) {
      const hint = document.querySelector('.editor-banner-hint');
      if (hint) hint.textContent = text;
    },

    _clearAddTempLayers: function () {
      const map = GIS.AppState.map;
      if (!map) return;

      if (this._addTempMarkers) {
        this._addTempMarkers.forEach(m => map.removeLayer(m));
        this._addTempMarkers = [];
      }
      if (this._addTempPolyline) {
        map.removeLayer(this._addTempPolyline);
        this._addTempPolyline = null;
      }
    },

    _handleAddMapClick: function (e) {
      const map = GIS.AppState.map;
      const latlng = e.latlng;

      if (this._addingShapeType === 'point') {
        this._finishAddPoint(latlng);
        return;
      }

      // ポリゴンで始点付近をクリックした場合は閉じて確定
      if (this._addingShapeType === 'polygon' && this._addPoints.length >= 3) {
        const firstPt = this._addPoints[0];
        const distPx = map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(firstPt));
        if (distPx < 16) {
          this._finishAddPolygon();
          return;
        }
      }

      this._addPoints.push(latlng);

      const marker = L.circleMarker(latlng, {
        radius: 6,
        color: '#8b5cf6',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2
      }).addTo(map);

      // ポリゴンモードで始点クリック用イベント
      if (this._addingShapeType === 'polygon' && this._addPoints.length === 1) {
        marker.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (this._addPoints.length >= 3) {
            this._finishAddPolygon();
          }
        });
      }

      this._addTempMarkers.push(marker);
      this._updateAddTempPolyline();
    },

    _handleAddMouseMove: function (e) {
      if (!this._isAddingShape || this._addPoints.length === 0) return;
      const map = GIS.AppState.map;
      if (!map) return;

      const pts = [...this._addPoints, e.latlng];
      if (!this._addTempPolyline) {
        this._addTempPolyline = L.polyline(pts, {
          color: '#8b5cf6',
          weight: 2.5,
          dashArray: '5, 8',
          opacity: 0.85
        }).addTo(map);
      } else {
        this._addTempPolyline.setLatLngs(pts);
      }
    },

    _updateAddTempPolyline: function () {
      const map = GIS.AppState.map;
      if (!map) return;
      if (!this._addTempPolyline) {
        this._addTempPolyline = L.polyline(this._addPoints, {
          color: '#8b5cf6',
          weight: 2.5,
          dashArray: '5, 8',
          opacity: 0.85
        }).addTo(map);
      } else {
        this._addTempPolyline.setLatLngs(this._addPoints);
      }
    },

    _handleAddMapDblClick: function (e) {
      L.DomEvent.stopPropagation(e);
      if (this._addingShapeType === 'line') {
        if (this._addPoints.length >= 2) {
          this._finishAddLine();
        } else {
          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast('⚠️ ラインは2点以上の頂点が必要です', 'warning');
          }
        }
      } else if (this._addingShapeType === 'polygon') {
        if (this._addPoints.length >= 3) {
          this._finishAddPolygon();
        } else {
          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast('⚠️ ポリゴンは3点以上の頂点が必要です', 'warning');
          }
        }
      }
    },

    _handleAddKeyDown: function (e) {
      if (e.key === 'Escape') {
        this._stopAddShape();
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('↩️ 新規図形追加をキャンセルしました', 'info');
        }
        return;
      }

      if (e.key === 'Enter') {
        if (this._addingShapeType === 'line') {
          if (this._addPoints.length >= 2) {
            this._finishAddLine();
          }
        } else if (this._addingShapeType === 'polygon') {
          if (this._addPoints.length >= 3) {
            this._finishAddPolygon();
          }
        }
      }
    },

    _ensureLayerIsGroup: function () {
      const entry = this.activeLayerEntry;
      if (!entry || !entry.layer) return null;

      if (typeof entry.layer.addLayer === 'function') {
        return entry.layer;
      }

      // 単体レイヤー（Marker, Polyline, Polygon等）だった場合はFeatureGroupに昇格
      const map = GIS.AppState.map;
      const oldLayer = entry.layer;
      if (map.hasLayer(oldLayer)) {
        map.removeLayer(oldLayer);
      }
      const grp = L.featureGroup([oldLayer]).addTo(map);
      entry.layer = grp;
      return grp;
    },

    _finishAddPoint: function (latlng) {
      const entry = this.activeLayerEntry;
      if (!entry) return;
      const group = this._ensureLayerIsGroup();

      const newPointLayer = L.circleMarker(latlng, {
        radius: 8,
        color: '#ffffff',
        fillColor: '#00d4ff',
        weight: 2,
        fillOpacity: 0.9
      });

      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [latlng.lng, latlng.lat]
        },
        properties: {
          name: `ポイント ${new Date().toLocaleTimeString()}`
        }
      };
      newPointLayer.feature = feature;

      group.addLayer(newPointLayer);
      this._addedLayersInCurrentSession.push(newPointLayer);

      if (entry.rawGeoJSON && entry.rawGeoJSON.type === 'FeatureCollection' && Array.isArray(entry.rawGeoJSON.features)) {
        entry.rawGeoJSON.features.push(feature);
      }

      // 長押しトリガーと編集ハンドルを設定
      this._attachLongPressToFeature(newPointLayer, entry.id);
      this._stopAddShape();
      this.selectFeature(newPointLayer);

      // レイヤーを未保存状態にする
      entry.isUnsaved = true;
      if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('✅ 新規ポイントを追加しました', 'success');
      }
    },

    _finishAddLine: function () {
      const entry = this.activeLayerEntry;
      if (!entry || this._addPoints.length < 2) return;
      const group = this._ensureLayerIsGroup();

      const latlngs = [...this._addPoints];
      const newLineLayer = L.polyline(latlngs, {
        color: '#00d4ff',
        weight: 3.5,
        opacity: 0.9
      });

      const coords = latlngs.map(p => [p.lng, p.lat]);
      const feature = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords
        },
        properties: {
          name: `ライン ${new Date().toLocaleTimeString()}`
        }
      };
      newLineLayer.feature = feature;

      group.addLayer(newLineLayer);
      this._addedLayersInCurrentSession.push(newLineLayer);

      if (entry.rawGeoJSON && entry.rawGeoJSON.type === 'FeatureCollection' && Array.isArray(entry.rawGeoJSON.features)) {
        entry.rawGeoJSON.features.push(feature);
      }

      this._attachLongPressToFeature(newLineLayer, entry.id);
      this._stopAddShape();
      this.selectFeature(newLineLayer);

      entry.isUnsaved = true;
      if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('✅ 新規ラインを追加しました', 'success');
      }
    },

    _finishAddPolygon: function () {
      const entry = this.activeLayerEntry;
      if (!entry || this._addPoints.length < 3) return;
      const group = this._ensureLayerIsGroup();

      const latlngs = [...this._addPoints];
      const newPolygonLayer = L.polygon(latlngs, {
        color: '#00d4ff',
        fillColor: '#00d4ff',
        weight: 2.5,
        opacity: 0.9,
        fillOpacity: 0.35
      });

      const coords = latlngs.map(p => [p.lng, p.lat]);
      if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
        coords.push([...coords[0]]);
      }
      const feature = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [coords]
        },
        properties: {
          name: `ポリゴン ${new Date().toLocaleTimeString()}`
        }
      };
      newPolygonLayer.feature = feature;

      group.addLayer(newPolygonLayer);
      this._addedLayersInCurrentSession.push(newPolygonLayer);

      if (entry.rawGeoJSON && entry.rawGeoJSON.type === 'FeatureCollection' && Array.isArray(entry.rawGeoJSON.features)) {
        entry.rawGeoJSON.features.push(feature);
      }

      this._attachLongPressToFeature(newPolygonLayer, entry.id);
      this._stopAddShape();
      this.selectFeature(newPolygonLayer);

      entry.isUnsaved = true;
      if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('✅ 新規ポリゴンを追加しました', 'success');
      }
    },

    /**
     * 編集を終了する
     * @param {boolean} [saveChanges=true] true: 編集を保存（未保存ステータス付与）, false: 保存しない
     */
    finishEdit: function (saveChanges = true) {
      if (!this._isEditing && !this.activeLayerEntry) return;

      this._stopAddShape();
      this._closeAddMenu();

      const entry = this.activeLayerEntry;
      const layer = entry ? entry.layer : null;

      this._clearHandles();

      // マーカー等のドラッグ無効化
      if (this.activeTargetFeature && this.activeTargetFeature.dragging && typeof this.activeTargetFeature.dragging.disable === 'function') {
        this.activeTargetFeature.dragging.disable();
      }
      if (layer) {
        if (layer.dragging && typeof layer.dragging.disable === 'function') layer.dragging.disable();
        if (layer.eachLayer) {
          layer.eachLayer(sub => {
            if (sub.dragging && typeof sub.dragging.disable === 'function') sub.dragging.disable();
          });
        }
      }

      if (saveChanges && entry) {
        // 編集内容を保存（レイヤーリストで未保存状態として色変更＆未保存バッジ表示）
        entry.isUnsaved = true;
        if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
          GIS.FloatingPanel.updateLayerItemStatus(entry.id);
        }
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`✓ 『${entry.name}』の編集内容を保存しました（未保存状態）`, 'success');
        }
      }

      this._hideBanner();
      this._isEditing = false;
      this.activeLayerId = null;
      this.activeLayerEntry = null;
      this.activeTargetFeature = null;
      this.selectedFeature = null;
      this._originalCoords = null;
      this._originalCoordsMap = null;
      this._addedLayersInCurrentSession = [];
      this._deletedLayersInCurrentSession = [];
      this._originalRawGeoJSONBackup = null;
      this._updateDeleteButtonState();

      // 編集終了時に離脱防止リスナーを解除
      if (this._beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
      }
    },

    /**
     * 編集をキャンセルして元の座標に戻す（保存しない）
     */
    cancelEdit: function () {
      if (!this._isEditing || !this.activeLayerEntry) {
        this.finishEdit(false);
        return;
      }

      const entryName = this.activeLayerEntry.name || 'レイヤー';

      // 1. 今回の編集セッション中に追加された新規図形をすべて破棄
      if (this._addedLayersInCurrentSession && this._addedLayersInCurrentSession.length > 0) {
        this._addedLayersInCurrentSession.forEach(layer => {
          if (this.activeLayerEntry && this.activeLayerEntry.layer && this.activeLayerEntry.layer.removeLayer) {
            this.activeLayerEntry.layer.removeLayer(layer);
          }
          if (GIS.AppState && GIS.AppState.map && GIS.AppState.map.hasLayer(layer)) {
            GIS.AppState.map.removeLayer(layer);
          }
        });
        this._addedLayersInCurrentSession = [];
      }

      // 2. 今回の編集セッション中に削除された図形を復元
      if (this._deletedLayersInCurrentSession && this._deletedLayersInCurrentSession.length > 0) {
        this._deletedLayersInCurrentSession.forEach(item => {
          if (item.parent && typeof item.parent.addLayer === 'function') {
            item.parent.addLayer(item.layer);
          } else if (this.activeLayerEntry && this.activeLayerEntry.layer && typeof this.activeLayerEntry.layer.addLayer === 'function') {
            this.activeLayerEntry.layer.addLayer(item.layer);
          }
          if (GIS.AppState && GIS.AppState.map && !GIS.AppState.map.hasLayer(item.layer)) {
            item.layer.addTo(GIS.AppState.map);
          }
          this._attachLongPressToFeature(item.layer, this.activeLayerId);
        });
        this._deletedLayersInCurrentSession = [];
      }

      // 3. rawGeoJSONのバックアップ復元
      if (this.activeLayerEntry && this._originalRawGeoJSONBackup) {
        this.activeLayerEntry.rawGeoJSON = JSON.parse(JSON.stringify(this._originalRawGeoJSONBackup));
      }

      // 4. 元の座標に復元
      this._restoreOriginalCoords();

      this.finishEdit(false);

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`↩️ 『${entryName}』の編集を破棄して元に戻しました`, 'info');
      }
    },

    /**
     * 編集内容を別ファイルとしてエクスポート保存
     */
    saveAndExport: function () {
      if (!this.activeLayerEntry) {
        this.finishEdit(false);
        return;
      }

      const entry = this.activeLayerEntry;
      const layer = entry.layer;
      const rawName = (entry.file && entry.file.name) || entry.name || 'layer';
      const baseName = rawName.replace(/\.[^/.]+$/, '');

      let geojson = null;

      // 1. toGeoJSONメソッドがある場合
      if (typeof layer.toGeoJSON === 'function') {
        geojson = layer.toGeoJSON();
      } else if (entry.rawGeoJSON) {
        // 生GeoJSONの座標を更新
        geojson = JSON.parse(JSON.stringify(entry.rawGeoJSON));
        this._updateGeoJsonCoordinates(geojson, layer);
      }

      if (!geojson) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('❌ GeoJSONデータの生成に失敗しました', 'error');
        }
        return;
      }

      // 元のファイル名＋日時（ローカル日時: YYYYMMDD_HHmmss）でファイル名生成
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `${baseName}_${dateStr}.geojson`;

      const blob = new Blob([JSON.stringify(geojson, null, 2)], {
        type: 'application/geo+json;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // 別ファイル保存が完了したため未保存状態を解除
      entry.isUnsaved = false;
      if (GIS.FloatingPanel && GIS.FloatingPanel.updateLayerItemStatus) {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`💾 『${filename}』として保存しました`, 'success');
      }

      this.finishEdit(false);
    },

    _updateGeoJsonCoordinates: function (geojson, layer) {
      if (!geojson || !layer) return;
      if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
        if (layer.eachLayer && typeof layer.eachLayer === 'function') {
          let idx = 0;
          layer.eachLayer(sub => {
            if (geojson.features[idx]) {
              this._updateSingleFeatureCoordinates(geojson.features[idx], sub);
            }
            idx++;
          });
        }
      } else if (geojson.type === 'Feature') {
        this._updateSingleFeatureCoordinates(geojson, layer);
      }
    },

    _updateSingleFeatureCoordinates: function (featureObj, subLayer) {
      if (!featureObj || !featureObj.geometry || !subLayer) return;
      if (typeof subLayer.getLatLng === 'function' && typeof subLayer.getLatLngs !== 'function') {
        const ll = subLayer.getLatLng();
        featureObj.geometry.coordinates = [ll.lng, ll.lat];
      } else if (typeof subLayer.getLatLngs === 'function') {
        const lls = subLayer.getLatLngs();
        if (featureObj.geometry.type === 'Polygon') {
          const ring = Array.isArray(lls[0]) ? lls[0] : lls;
          const coords = ring.map(pt => [pt.lng, pt.lat]);
          if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
            coords.push([...coords[0]]);
          }
          featureObj.geometry.coordinates = [coords];
        } else if (featureObj.geometry.type === 'LineString') {
          featureObj.geometry.coordinates = lls.map(pt => [pt.lng, pt.lat]);
        }
      }
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    GIS.GeometryEditor.init();
  });

})(window.GIS = window.GIS || {});
