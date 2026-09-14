/**
 * layerHistoryHandler.js - 読み込んだレイヤー履歴の保存・復元管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  const DB_NAME = 'gis_layer_history_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'layers';
  const MAX_HISTORY = 10;
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  GIS.LayerHistoryHandler = {
    _db: null,
    _dbPromise: null,

    init() {
      this._initDB();
      this._bindUI();
    },

    _initDB() {
      if (!window.indexedDB) return;

      this._dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            store.createIndex('name', 'name', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = (e) => {
          this._db = e.target.result;
          resolve(this._db);
        };
        req.onerror = (e) => {
          console.warn('[LayerHistory] DB open error:', e);
          reject(e);
        };
      });
    },

    _bindUI() {
      // 「最近読み込んだレイヤ」モーダルの閉じるボタン等
      const modal = document.getElementById('layer-history-modal');
      const closeBtn = document.getElementById('btn-close-layer-history');
      const clearBtn = document.getElementById('btn-clear-layer-history');
      const restoreAllBtn = document.getElementById('btn-restore-all-layers');

      if (closeBtn && modal) {
        closeBtn.addEventListener('click', () => {
          modal.style.display = 'none';
        });
      }

      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (confirm('レイヤー履歴をすべて消去しますか？')) {
            await this.clearHistory();
            this.renderHistoryModal();
            if (GIS.UI && GIS.UI.showToast) {
              GIS.UI.showToast('🗑️ レイヤー履歴を消去しました', 'info');
            }
          }
        });
      }

      if (restoreAllBtn) {
        restoreAllBtn.addEventListener('click', async () => {
          await this.restoreAllLayers();
        });
      }
    },

    /**
     * ファイル読み込み成功時に履歴に記録
     * @param {File} file
     * @param {string} type
     */
    async recordFile(file, type) {
      if (!this._dbPromise || !file) return;
      if (file.size > MAX_FILE_SIZE) {
        console.warn('[LayerHistory] File size exceeds 50MB, skipping history persistence:', file.name);
        return;
      }

      try {
        if (!this._db) await this._dbPromise;
        if (!this._db) return;

        // 同名ファイルが既にあれば古いレコードを削除して最新化
        await this._removeByName(file.name);

        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const record = {
          name: file.name,
          type: type || 'geojson',
          mime: file.type,
          size: file.size,
          blob: file, // FileはBlobを継承
          timestamp: Date.now()
        };

        store.add(record);

        tx.oncomplete = () => {
          this._trimHistory();
        };
      } catch (e) {
        console.warn('[LayerHistory] Failed to record layer:', e);
      }
    },

    async _removeByName(name) {
      if (!this._db) return;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          const index = store.index('name');
          const req = index.openCursor(IDBKeyRange.only(name));
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              store.delete(cursor.primaryKey);
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    },

    async _trimHistory() {
      if (!this._db) return;
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const countReq = store.count();
        countReq.onsuccess = () => {
          const count = countReq.result;
          if (count > MAX_HISTORY) {
            const deleteCount = count - MAX_HISTORY;
            const index = store.index('timestamp');
            const curReq = index.openCursor(); // 昇順（最古順）
            let deleted = 0;
            curReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor && deleted < deleteCount) {
                store.delete(cursor.primaryKey);
                deleted++;
                cursor.continue();
              }
            };
          }
        };
      } catch (_) {}
    },

    async getHistory() {
      if (!this._db) await this._dbPromise;
      if (!this._db) return [];

      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();
          req.onsuccess = () => {
            const list = req.result || [];
            list.sort((a, b) => b.timestamp - a.timestamp); // 降順（新しい順）
            resolve(list);
          };
          req.onerror = () => resolve([]);
        } catch (_) {
          resolve([]);
        }
      });
    },

    /**
     * 履歴モーダルを表示・描画する
     */
    async openHistoryModal() {
      const modal = document.getElementById('layer-history-modal');
      if (!modal) return;
      modal.style.display = 'flex';
      await this.renderHistoryModal();
    },

    async renderHistoryModal() {
      const listEl = document.getElementById('layer-history-list');
      const restoreAllBtn = document.getElementById('btn-restore-all-layers');
      if (!listEl) return;

      const history = await this.getHistory();
      if (!history.length) {
        listEl.innerHTML = '<div class="history-empty-message">保存されているレイヤー履歴はありません。</div>';
        if (restoreAllBtn) restoreAllBtn.disabled = true;
        return;
      }

      if (restoreAllBtn) restoreAllBtn.disabled = false;
      listEl.innerHTML = '';

      history.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'history-item-row';

        const typeIcons = { geojson: '📐', kml: '🗺️', gpx: '🚴', geotiff: '🛰️', image: '📷', fgb: '⚡', shp: '🔷' };
        const icon = typeIcons[item.type] || '📄';
        const sizeMb = (item.size / (1024 * 1024)).toFixed(2);
        const dateStr = new Date(item.timestamp).toLocaleString('ja-JP', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });

        row.innerHTML = `
          <div class="history-item-info">
            <span class="history-item-icon">${icon}</span>
            <div class="history-item-meta">
              <strong class="history-item-name" title="${item.name}">${item.name}</strong>
              <span class="history-item-detail">${sizeMb} MB | ${dateStr}</span>
            </div>
          </div>
          <div class="history-item-actions">
            <button class="btn-restore-single" data-id="${item.id}" title="地図上に復元再表示">再表示</button>
            <button class="btn-delete-single" data-id="${item.id}" title="履歴から削除">✕</button>
          </div>
        `;

        row.querySelector('.btn-restore-single').addEventListener('click', async () => {
          await this.restoreSingleLayer(item);
        });

        row.querySelector('.btn-delete-single').addEventListener('click', async () => {
          await this.deleteSingleHistory(item.id);
          this.renderHistoryModal();
        });

        listEl.appendChild(row);
      });
    },

    /**
     * 単一レイヤーの復元
     */
    async restoreSingleLayer(item) {
      if (!item || !item.blob || !GIS.FileHandler) return;

      try {
        const file = new File([item.blob], item.name, { type: item.mime || 'application/octet-stream' });
        await GIS.FileHandler.handleFiles([file]);

        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`📍 「${item.name}」を復元しました`, 'success');
        }

        const modal = document.getElementById('layer-history-modal');
        if (modal) modal.style.display = 'none';
      } catch (err) {
        console.error('[LayerHistory] Restore failed:', err);
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast(`⚠️ 「${item.name}」の復元に失敗しました`, 'warning');
        }
      }
    },

    /**
     * 全履歴の一括復元
     */
    async restoreAllLayers() {
      const history = await this.getHistory();
      if (!history.length || !GIS.FileHandler) return;

      const files = history.map(item => new File([item.blob], item.name, { type: item.mime || 'application/octet-stream' }));
      await GIS.FileHandler.handleFiles(files);

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`📍 ${files.length}件のレイヤーをすべて復元しました`, 'success');
      }

      const modal = document.getElementById('layer-history-modal');
      if (modal) modal.style.display = 'none';
    },

    async deleteSingleHistory(id) {
      if (!this._db) return;
      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    },

    async clearHistory() {
      if (!this._db) await this._dbPromise;
      if (!this._db) return;

      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch (_) {
          resolve();
        }
      });
    }
  };

})(window.GIS = window.GIS || {});
