/**
 * floatingPanel.js - 折りたたみ可能フローティングパネルのUI管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.FloatingPanel = {
    _panel: null,
    _header: null,
    _body: null,
    _collapsed: false,
    _dragging: false,
    _dragOffset: { x: 0, y: 0 },

    /**
     * パネルを初期化する
     */
    init() {
      this._panel = document.getElementById('floating-panel');
      this._header = document.getElementById('panel-header');
      this._body = document.getElementById('panel-body');
      const toggleBtn = document.getElementById('panel-toggle');
      const clearAllBtn = document.getElementById('clear-all-btn');
      const dropZone = document.getElementById('drop-zone');
      const fileInput = document.getElementById('file-input');

      // 折りたたみトグル
      toggleBtn.addEventListener('click', () => this.toggleCollapse());

      // 全削除ボタン
      clearAllBtn.addEventListener('click', () => {
        if (confirm('すべてのレイヤーを削除しますか？')) {
          GIS.AppState.clearAllLayers();
        }
      });

      // ドラッグ移動（ヘッダー）
      this._initDragMove();

      // ドロップゾーン
      this._initDropZone(dropZone);

      // ファイル選択（クリックでファイルダイアログ）
      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
        fileInput.value = ''; // リセット
      });

      // 一括マスク設定セレクター
      const batchMaskSelect = document.getElementById('batch-mask-select');
      if (batchMaskSelect) {
        batchMaskSelect.addEventListener('change', (e) => {
          if (GIS.ZoningHandler) {
            GIS.ZoningHandler.applyBatchMask(e.target.value);
          }
        });
      }

      // 作図ツール起動ボタン（単一ボタン）
      const btnToggleDrawing = document.getElementById('btn-toggle-drawing');
      if (btnToggleDrawing) {
        btnToggleDrawing.addEventListener('click', () => {
          if (GIS.PolygonDrawer) {
            GIS.PolygonDrawer.toggleDrawing();
          }
        });
      }

      // 「最近読み込んだレイヤ」ボタン
      const btnRecentLayers = document.getElementById('btn-recent-layers');
      if (btnRecentLayers) {
        btnRecentLayers.addEventListener('click', () => {
          if (GIS.LayerHistoryHandler) {
            GIS.LayerHistoryHandler.openHistoryModal();
          }
        });
      }

      // 状態変化を反映
      GIS.AppState.on('layerAdded', (entry) => {
        this._addLayerItem(entry);
        if (GIS.ZoningHandler) {
          GIS.ZoningHandler.updateAllMaskSelectOptions();
          GIS.ZoningHandler.refreshMaskedGeoTIFFs(entry.id);
        }
      });
      GIS.AppState.on('layerRemoved', ({ id }) => {
        this._removeLayerItem(id);
        if (GIS.ZoningHandler) {
          GIS.ZoningHandler.updateAllMaskSelectOptions();
          GIS.ZoningHandler.refreshMaskedGeoTIFFs(id);
        }
      });
      GIS.AppState.on('layerToggled', ({ id, visible }) => {
        this._updateLayerItemVisibility(id, visible);
        if (GIS.ZoningHandler) {
          GIS.ZoningHandler.updateAllMaskSelectOptions();
          GIS.ZoningHandler.refreshMaskedGeoTIFFs(id);
        }
      });
      GIS.AppState.on('allLayersCleared', () => {
        this._clearLayerList();
        if (GIS.ZoningHandler) {
          GIS.ZoningHandler.updateAllMaskSelectOptions();
        }
      });
    },

    /**
     * パネルの折りたたみ/展開をトグルする
     */
    toggleCollapse() {
      this._collapsed = !this._collapsed;
      this._body.style.display = this._collapsed ? 'none' : '';
      const btn = document.getElementById('panel-toggle');
      btn.textContent = this._collapsed ? '⌄' : '⌃';
      btn.title = this._collapsed ? '展開する' : '折りたたむ';
      this._panel.classList.toggle('collapsed', this._collapsed);
    },

    /**
     * パネルの表示/非表示を切り替える（PDF出力時などに使用）
     * @param {boolean} visible
     */
    setVisible(visible) {
      this._panel.style.display = visible ? '' : 'none';
    },

    /**
     * ドラッグ移動を初期化する
     */
    _initDragMove() {
      const handle = document.getElementById('panel-drag-handle');

      const onMouseDown = (e) => {
        if (e.target.closest('button')) return;
        this._dragging = true;
        const rect = this._panel.getBoundingClientRect();
        this._dragOffset.x = e.clientX - rect.left;
        this._dragOffset.y = e.clientY - rect.top;
        this._panel.style.transition = 'none';
        e.preventDefault();
      };

      const onMouseMove = (e) => {
        if (!this._dragging) return;
        const x = Math.max(0, Math.min(window.innerWidth - this._panel.offsetWidth, e.clientX - this._dragOffset.x));
        const y = Math.max(0, Math.min(window.innerHeight - this._panel.offsetHeight, e.clientY - this._dragOffset.y));
        this._panel.style.left = x + 'px';
        this._panel.style.top = y + 'px';
        this._panel.style.right = 'auto';
        this._panel.style.bottom = 'auto';
      };

      const onMouseUp = () => {
        this._dragging = false;
        this._panel.style.transition = '';
      };

      handle.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      // タッチ対応
      handle.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        onMouseDown({ clientX: t.clientX, clientY: t.clientY, target: e.target, preventDefault: () => e.preventDefault() });
      }, { passive: false });
      document.addEventListener('touchmove', (e) => {
        if (!this._dragging) return;
        const t = e.touches[0];
        onMouseMove({ clientX: t.clientX, clientY: t.clientY });
      }, { passive: false });
      document.addEventListener('touchend', onMouseUp);
    },

    /**
     * ドロップゾーンを初期化する
     * @param {HTMLElement} zone
     */
    _initDropZone(zone) {
      // dragenter / dragover : ハイライト表示
      ['dragenter', 'dragover'].forEach(ev => {
        zone.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.add('drag-over');
        });
      });

      // dragleave / dragend : ハイライト解除のみ
      ['dragleave', 'dragend'].forEach(ev => {
        zone.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.remove('drag-over');
        });
      });

      // drop : ファイルを処理する（ここが重要）
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
      });

      // ドロップゾーン外（地図上など）へのドロップも受け付ける
      document.addEventListener('dragover', (e) => e.preventDefault());
      document.addEventListener('drop', (e) => {
        // ドロップゾーン自体へのdropはstopPropagationで止めてあるので
        // ここに来るのはゾーン外へのドロップのみ
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) GIS.FileHandler.handleFiles(files);
      });
    },

    /**
     * レイヤーセット（能登半島LiDAR、県営林、林道などプリセット）かどうか判定
     * @param {object} entry
     * @returns {boolean}
     */
    _isLayerSet(entry) {
      if (!entry) return false;
      if (entry.isLayerSet) return true;
      if (GIS.NotoLidarHandler && GIS.NotoLidarHandler.layerIds && GIS.NotoLidarHandler.layerIds.includes(entry.id)) return true;
      if (GIS.ForestRoadHandler && (entry.id === GIS.ForestRoadHandler.keneirinLayerId || entry.id === GIS.ForestRoadHandler.roadLayerId)) return true;
      if (entry.name === '県営林' || entry.name === '能登半島LiDAR' || entry.name === '林道台帳' || entry.name === '県営林（ポリゴン）' || entry.name === '林道台帳（ライン）') return true;
      return false;
    },

    /**
     * レイヤーリストにアイテムを追加する
     * @param {object} entry
     */
    _addLayerItem(entry) {
      const list = document.getElementById('layer-list');
      // 「レイヤーがありません」メッセージを削除
      const empty = list.querySelector('.layer-list-empty');
      if (empty) empty.remove();

      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.layerId = entry.id;

      const typeIcon = this._getTypeIcon(entry.type);
      const isGeoTiff = entry.type === 'geotiff' && entry.geotiffInfo;
      const zoningBtnHtml = isGeoTiff ? `<button class="layer-zoning-toggle-btn" title="シンボロジ / ゾーニング設定" data-id="${entry.id}">🎨 スタイル</button>` : '';

      const drawerHtml = (isGeoTiff && GIS.ZoningHandler) ? GIS.ZoningHandler.createDrawerHtml(entry) : '';

      const isTileLayer = entry.type === 'tile' || (entry.layer && (entry.layer instanceof L.TileLayer || entry.layer instanceof L.GridLayer));
      const canZoom = !isTileLayer;
      const isLayerSet = this._isLayerSet(entry);
      const canRename = !isLayerSet;

      const visTitleAttr = canZoom ? 'title="表示/非表示（2秒長押しで全体表示）"' : 'title="表示/非表示"';
      const nameTitleAttr = canRename ? `${entry.name}（2秒長押しでレイヤ名編集）` : entry.name;
      const canRenameClass = canRename ? ' can-rename' : '';
      const unsavedClass = entry.isUnsaved ? ' layer-unsaved' : '';
      const unsavedBadgeHtml = entry.isUnsaved ? '<span class="layer-unsaved-badge" title="編集内容が未保存です">未保存</span>' : '';

      li.className = `layer-item${unsavedClass}`;
      li.dataset.layerId = entry.id;

      li.innerHTML = `
        <div class="layer-item-header">
          <button class="layer-vis-btn${canZoom ? ' can-zoom' : ''}" ${visTitleAttr} data-id="${entry.id}">👁</button>
          <span class="layer-type-icon">${typeIcon}</span>
          <span class="layer-name${canRenameClass}" title="${nameTitleAttr}">${entry.name}</span>
          ${unsavedBadgeHtml}
          ${zoningBtnHtml}
          <button class="layer-del-btn" title="削除" data-id="${entry.id}">✕</button>
        </div>
        ${drawerHtml}
      `;

      const visBtn = li.querySelector('.layer-vis-btn');
      this._bindVisibilityLongPress(visBtn, entry.id, canZoom);

      const nameEl = li.querySelector('.layer-name');
      if (canRename) {
        this._bindLayerRename(nameEl, entry);
      }

      li.querySelector('.layer-del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        GIS.AppState.removeLayer(entry.id);
      });

      if (isGeoTiff && GIS.ZoningHandler) {
        GIS.ZoningHandler.bindDrawerEvents(entry.id, li);
      }

      list.appendChild(li);
    },

    /**
     * 表示/非表示ボタンに2秒長押し（全体表示）および短押し（表示切替）イベントを設定
     * @param {HTMLElement} visBtn
     * @param {string} layerId
     * @param {boolean} canZoom
     */
    _bindVisibilityLongPress(visBtn, layerId, canZoom) {
      let timer = null;
      let startX = 0;
      let startY = 0;
      let isLongPressed = false;
      const LONG_PRESS_DURATION = 2000; // 2秒以上

      const cancelPress = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        visBtn.classList.remove('is-pressing');
      };

      const startPress = (clientX, clientY) => {
        isLongPressed = false;
        startX = clientX;
        startY = clientY;
        visBtn.classList.add('is-pressing');

        if (canZoom) {
          timer = setTimeout(() => {
            isLongPressed = true;
            visBtn.classList.remove('is-pressing');
            visBtn.classList.add('vis-zoom-triggered');
            setTimeout(() => {
              visBtn.classList.remove('vis-zoom-triggered');
            }, 600);

            if (navigator.vibrate) {
              try { navigator.vibrate(50); } catch (_) {}
            }

            this.zoomToLayer(layerId);
            timer = null;
          }, LONG_PRESS_DURATION);
        }
      };

      // マウスイベント
      visBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        startPress(e.clientX, e.clientY);
      });

      visBtn.addEventListener('mousemove', (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
          cancelPress();
        }
      });

      visBtn.addEventListener('mouseup', cancelPress);
      visBtn.addEventListener('mouseleave', cancelPress);

      // タッチイベント
      visBtn.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) {
          cancelPress();
          return;
        }
        const touch = e.touches[0];
        startPress(touch.clientX, touch.clientY);
      }, { passive: true });

      visBtn.addEventListener('touchmove', (e) => {
        if (!timer || e.touches.length !== 1) {
          cancelPress();
          return;
        }
        const touch = e.touches[0];
        if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
          cancelPress();
        }
      }, { passive: true });

      visBtn.addEventListener('touchend', cancelPress);
      visBtn.addEventListener('touchcancel', cancelPress);

      // 短押しクリック時: 表示/非表示切り替え（長押しトリガー時は何もしない）
      visBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isLongPressed) {
          e.preventDefault();
          isLongPressed = false;
          return;
        }
        GIS.AppState.toggleLayer(layerId);
      });
    },

    /**
     * レイヤー名に2秒長押しで名前編集モードを開始するイベントを設定
     * @param {HTMLElement} nameEl
     * @param {object} entry
     */
    _bindLayerRename(nameEl, entry) {
      let timer = null;
      let startX = 0;
      let startY = 0;
      let isEditing = false;
      const LONG_PRESS_DURATION = 2000; // 2秒以上

      const cancelPress = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        nameEl.classList.remove('is-pressing-rename');
      };

      const startPress = (clientX, clientY) => {
        if (isEditing) return;
        startX = clientX;
        startY = clientY;
        nameEl.classList.add('is-pressing-rename');

        timer = setTimeout(() => {
          cancelPress();
          startEditing();
        }, LONG_PRESS_DURATION);
      };

      const startEditing = () => {
        if (isEditing) return;
        isEditing = true;

        if (navigator.vibrate) {
          try { navigator.vibrate(50); } catch (_) {}
        }

        const currentName = entry.name || '';
        nameEl.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-name-edit-input';
        input.value = currentName;
        nameEl.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const finish = (save) => {
          if (committed) return;
          committed = true;
          isEditing = false;

          const val = input.value.trim();
          if (save && val && val !== currentName) {
            entry.name = val;
            if (entry.file) entry.file.name = val;
            nameEl.textContent = val;
            nameEl.title = `${val}（2秒長押しでレイヤ名編集）`;

            // ジオメトリ編集バーが開いていて同じレイヤーの場合、表示名も更新
            const editorTitle = document.getElementById('geometry-editor-layer-name');
            if (editorTitle && GIS.GeometryEditor && GIS.GeometryEditor.activeLayerId === entry.id) {
              editorTitle.textContent = val;
            }

            if (GIS.UI && GIS.UI.showToast) {
              GIS.UI.showToast(`レイヤー名を「${val}」に変更しました`, 'success');
            }
          } else {
            nameEl.textContent = entry.name;
            nameEl.title = `${entry.name}（2秒長押しでレイヤ名編集）`;
          }
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        });

        input.addEventListener('blur', () => {
          finish(true);
        });

        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('touchstart', (e) => e.stopPropagation());
      };

      // マウスイベント
      nameEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || isEditing) return;
        startPress(e.clientX, e.clientY);
      });

      nameEl.addEventListener('mousemove', (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) {
          cancelPress();
        }
      });

      nameEl.addEventListener('mouseup', cancelPress);
      nameEl.addEventListener('mouseleave', cancelPress);

      // タッチイベント
      nameEl.addEventListener('touchstart', (e) => {
        if (isEditing || e.touches.length !== 1) {
          cancelPress();
          return;
        }
        const touch = e.touches[0];
        startPress(touch.clientX, touch.clientY);
      }, { passive: true });

      nameEl.addEventListener('touchmove', (e) => {
        if (!timer || e.touches.length !== 1) {
          cancelPress();
          return;
        }
        const touch = e.touches[0];
        if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
          cancelPress();
        }
      }, { passive: true });

      nameEl.addEventListener('touchend', cancelPress);
      nameEl.addEventListener('touchcancel', cancelPress);
    },

    /**
     * 指定レイヤーの全体範囲にズームする
     * @param {string} id
     */
    zoomToLayer(id) {
      if (!GIS.AppState || !GIS.AppState.map) return;
      const entry = GIS.AppState.layers.get(id);
      if (!entry) return;

      // 配信タイルは全体範囲が定義されていないためズーム対象外
      if (entry.type === 'tile' || (entry.layer && (entry.layer instanceof L.TileLayer || entry.layer instanceof L.GridLayer))) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`ℹ️ 配信タイルは全体範囲が定義されていないためズーム対象外です`, 'info');
        }
        return;
      }

      const bounds = this._getLayerBounds(entry);
      if (bounds && bounds.isValid()) {
        const isPoint = bounds.getNorthEast().equals(bounds.getSouthWest());
        if (isPoint) {
          GIS.AppState.map.flyTo(bounds.getCenter(), 16, { duration: 1.2 });
        } else {
          GIS.AppState.map.flyToBounds(bounds, {
            padding: [50, 50],
            maxZoom: 17,
            duration: 1.2
          });
        }
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`🔍 「${entry.name}」の範囲全体にズームしました`, 'info');
        }
      } else {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`⚠️ 「${entry.name}」の範囲情報を取得できませんでした`, 'warning');
        }
      }
    },

    /**
     * レイヤーの境界範囲を取得する
     * @param {object} entry
     * @returns {L.LatLngBounds|null}
     */
    _getLayerBounds(entry) {
      if (!entry) return null;

      // 配信タイルは全体範囲なし
      if (entry.type === 'tile' || (entry.layer && (entry.layer instanceof L.TileLayer || entry.layer instanceof L.GridLayer))) {
        return null;
      }

      const layer = entry.layer;

      // 1. レイヤー自体が getBounds を持つ場合（GeoJSON, FeatureGroup, ImageOverlay など）
      if (layer && typeof layer.getBounds === 'function') {
        try {
          const b = layer.getBounds();
          if (b && typeof b.isValid === 'function' && b.isValid()) return b;
        } catch (e) {}
      }

      // 2. 単一マーカーの場合（getLatLng）
      if (layer && typeof layer.getLatLng === 'function') {
        try {
          const ll = layer.getLatLng();
          if (ll) return L.latLngBounds([ll, ll]);
        } catch (e) {}
      }

      // 3. LayerGroup / FeatureGroup の子要素走査
      if (layer && typeof layer.eachLayer === 'function') {
        try {
          const bounds = L.latLngBounds();
          layer.eachLayer((child) => {
            if (typeof child.getBounds === 'function') {
              try {
                const cb = child.getBounds();
                if (cb && cb.isValid && cb.isValid()) bounds.extend(cb);
              } catch (e) {}
            } else if (typeof child.getLatLng === 'function') {
              try {
                const cll = child.getLatLng();
                if (cll) bounds.extend(cll);
              } catch (e) {}
            }
          });
          if (bounds.isValid()) return bounds;
        } catch (e) {}
      }

      // 4. rawGeoJSON がある場合
      if (entry.rawGeoJSON) {
        try {
          const temp = L.geoJSON(entry.rawGeoJSON);
          const b = temp.getBounds();
          if (b && b.isValid && b.isValid()) return b;
        } catch (e) {}
      }

      // 5. GeoTIFF メタデータの境界
      if (entry.geotiffInfo && entry.geotiffInfo.bounds) {
        try {
          const b = L.latLngBounds(entry.geotiffInfo.bounds);
          if (b && b.isValid && b.isValid()) return b;
        } catch (e) {}
      }

      return null;
    },

    /**
     * レイヤーリストからアイテムを削除する
     * @param {string} id
     */
    _removeLayerItem(id) {
      const list = document.getElementById('layer-list');
      const item = list.querySelector(`[data-layer-id="${id}"]`);
      if (item) item.remove();
      if (!list.children.length) {
        list.innerHTML = '<li class="layer-list-empty">レイヤーがありません</li>';
      }
    },

    /**
     * レイヤーアイテムの表示状態を更新する
     * @param {string} id
     * @param {boolean} visible
     */
    _updateLayerItemVisibility(id, visible) {
      const list = document.getElementById('layer-list');
      const item = list.querySelector(`[data-layer-id="${id}"]`);
      if (!item) return;
      item.classList.toggle('layer-hidden', !visible);
      const btn = item.querySelector('.layer-vis-btn');
      if (btn) btn.textContent = visible ? '👁' : '🙈';
    },

    /**
     * レイヤーアイテムの未保存状態表示（バッジ・枠線色）を更新する
     * @param {string} id
     */
    updateLayerItemStatus(id) {
      const list = document.getElementById('layer-list');
      if (!list) return;
      const li = list.querySelector(`[data-layer-id="${id}"]`);
      if (!li) return;
      const entry = GIS.AppState.layers.get(id);
      if (!entry) return;

      li.classList.toggle('layer-unsaved', !!entry.isUnsaved);
      let badge = li.querySelector('.layer-unsaved-badge');
      if (entry.isUnsaved) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'layer-unsaved-badge';
          badge.textContent = '未保存';
          badge.title = '編集内容が未保存（エクスポート未実施）の状態です';
          const nameEl = li.querySelector('.layer-name');
          if (nameEl && nameEl.nextSibling) {
            nameEl.parentNode.insertBefore(badge, nameEl.nextSibling);
          } else if (nameEl) {
            nameEl.parentNode.appendChild(badge);
          }
        }
      } else {
        if (badge) badge.remove();
      }
    },

    /**
     * レイヤーリストをクリアする
     */
    _clearLayerList() {
      const list = document.getElementById('layer-list');
      list.innerHTML = '<li class="layer-list-empty">レイヤーがありません</li>';
    },

    /**
     * レイヤータイプに応じたアイコンを返す
     * @param {string} type
     * @returns {string}
     */
    _getTypeIcon(type) {
      const icons = { kml: '🗺️', geojson: '📐', image: '📷', geotiff: '🛰️', pin: '📍', track: '🚶' };
      return icons[type] || '📄';
    }
  };

})(window.GIS = window.GIS || {});
