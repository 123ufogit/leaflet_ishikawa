/**
 * offlineMapHandler.js - IndexedDBタイルキャッシュとオフライン/テストモード管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  const DB_NAME = 'gis_offline_tiles_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'tiles';
  const MAX_TILES = 2500; // 最大タイルキャッシュ数（約30〜50MB）

  GIS.OfflineMapHandler = {
    _map: null,
    _offlineBtn: null,
    _mode: 0, // 0: 通常(オンライン+順次キャッシュ), 1: オフライン(キャッシュ優先), 2: オフラインテスト(新規遮断・キャッシュのみ)
    _db: null,
    _dbPromise: null,

    init(map) {
      this._map = map;
      this._offlineBtn = document.getElementById('btn-mobile-offline');
      this._initDB();
      this._hookTileLayer();
      this._bindEvents();
      this._updateVisibility();
      window.addEventListener('resize', () => this._updateVisibility());
    },

    _initDB() {
      if (!window.indexedDB) {
        console.warn('[OfflineMap] IndexedDB is not supported.');
        return;
      }

      this._dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        };
        req.onsuccess = (e) => {
          this._db = e.target.result;
          resolve(this._db);
        };
        req.onerror = (e) => {
          console.error('[OfflineMap] IndexedDB open error:', e);
          reject(e);
        };
      });
    },

    _updateVisibility() {
      if (!this._offlineBtn) return;
      // iPad（11インチ等）、タブレット、スマホ、PCすべてで常に利用可能にする
      this._offlineBtn.style.display = 'flex';
    },

    _bindEvents() {
      if (this._offlineBtn) {
        this._offlineBtn.addEventListener('click', () => {
          this.toggleMode();
        });
      }

      // キャッシュクリアボタンと使用量表示（操作パネル内に折りたたまれている）
      const clearBtn = document.getElementById('btn-clear-offline-cache');
      if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
          if (confirm('保存されたオフライン地図キャッシュをすべて消去しますか？')) {
            await this.clearCache();
            if (GIS.UI && GIS.UI.showToast) {
              GIS.UI.showToast('🗑️ オフラインキャッシュを消去しました', 'info');
            }
          }
        });
      }
    },

    /**
     * モードトグル: 0(通常) -> 1(オフライン) -> 2(テスト) -> 0
     */
    toggleMode() {
      if (this._mode === 0) {
        this._mode = 1;
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('📴 オフラインモード: キャッシュデータを使用して地図を表示中', 'info');
        }
      } else if (this._mode === 1) {
        this._mode = 2;
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('🧪 オフラインテストモード: 新規読込を遮断中（キャッシュ済みの範囲のみ表示）', 'warning');
        }
      } else {
        this._mode = 0;
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('🌐 通常モードに戻りました', 'info');
        }
      }

      this._updateButtonUI();

      // 現在のタイルレイヤーを再描画してモードを即時反映
      if (this._map) {
        this._map.eachLayer((layer) => {
          if (layer instanceof L.TileLayer && typeof layer.redraw === 'function') {
            layer.redraw();
          }
        });
      }
    },

    _updateButtonUI() {
      if (!this._offlineBtn) return;
      this._offlineBtn.classList.remove('mode-offline', 'mode-test');

      const iconSpan = this._offlineBtn.querySelector('.mobile-btn-icon') || this._offlineBtn;

      if (this._mode === 1) {
        this._offlineBtn.classList.add('mode-offline');
        iconSpan.textContent = '📴';
        this._offlineBtn.title = 'オフラインモード（クリックでテストモードへ）';
      } else if (this._mode === 2) {
        this._offlineBtn.classList.add('mode-test');
        iconSpan.textContent = '🧪';
        this._offlineBtn.title = 'オフラインテストモード（クリックで通常モードへ）';
      } else {
        iconSpan.textContent = '🌐';
        this._offlineBtn.title = '通常オンラインモード（クリックでオフラインモードへ）';
      }
    },

    /**
     * LeafletのTileLayer描画パイプラインにフック
     */
    _hookTileLayer() {
      const self = this;
      const originalCreateTile = L.TileLayer.prototype.createTile;

      L.TileLayer.prototype.createTile = function (coords, done) {
        const tile = document.createElement('img');
        L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
        L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));

        if (this.options.crossOrigin || this.options.crossOrigin === '') {
          tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
        }

        tile.alt = '';
        tile.setAttribute('role', 'presentation');

        const url = this.getTileUrl(coords);
        const tileKey = `${coords.z}/${coords.x}/${coords.y}_${this._url || ''}`;

        // オフラインテストモード（mode === 2）: 新規フェッチを完全遮断
        if (self._mode === 2) {
          self.getTileBlob(tileKey).then((blob) => {
            if (blob) {
              tile.src = URL.createObjectURL(blob);
            } else {
              // 未キャッシュの場合は破線メッシュのCanvasタイルを描画
              self._createUncachedCanvas(coords, tile, done);
            }
          }).catch(() => {
            self._createUncachedCanvas(coords, tile, done);
          });
          return tile;
        }

        // オフラインモード（mode === 1）: キャッシュ優先
        if (self._mode === 1) {
          self.getTileBlob(tileKey).then((blob) => {
            if (blob) {
              tile.src = URL.createObjectURL(blob);
            } else {
              // キャッシュになければネットワーク取得を試行
              tile.src = url;
            }
          }).catch(() => {
            tile.src = url;
          });
          return tile;
        }

        // 通常モード（mode === 0）: 通常表示しつつバックグラウンドでキャッシュ保存
        tile.src = url;
        self._cacheTileInBackground(tileKey, url);

        return tile;
      };
    },

    /**
     * 未キャッシュエリア用の破線メッシュCanvasを生成
     */
    _createUncachedCanvas(coords, tile, done) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');

      // 背景
      ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
      ctx.fillRect(0, 0, 256, 256);

      // 破線グリッド
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(2, 2, 252, 252);

      // テキスト
      ctx.fillStyle = 'rgba(248, 113, 113, 0.85)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('未キャッシュ', 128, 120);

      ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.font = '10px sans-serif';
      ctx.fillText(`z:${coords.z} x:${coords.x} y:${coords.y}`, 128, 140);

      tile.src = canvas.toDataURL();
    },

    /**
     * バックグラウンドでタイルを非同期フェッチしてIndexedDBへ保存
     */
    async _cacheTileInBackground(key, url) {
      if (!this._dbPromise || !url || url.startsWith('data:') || url.startsWith('blob:')) return;

      try {
        const existing = await this.getTileBlob(key);
        if (existing) return; // 既にキャッシュ済み

        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) return;
        const blob = await res.blob();
        await this.saveTile(key, blob);
      } catch (_) {
        // CORS制約やオフライン時は静かに無視
      }
    },

    async saveTile(key, blob) {
      if (!this._db) await this._dbPromise;
      if (!this._db) return;

      return new Promise((resolve, reject) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.put({
            key,
            blob,
            size: blob.size || 0,
            timestamp: Date.now()
          });
          tx.oncomplete = () => {
            this._checkAndPurge();
            resolve();
          };
          tx.onerror = (e) => reject(e);
        } catch (e) {
          reject(e);
        }
      });
    },

    async getTileBlob(key) {
      if (!this._db) await this._dbPromise;
      if (!this._db) return null;

      return new Promise((resolve) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(key);
          req.onsuccess = () => {
            resolve(req.result ? req.result.blob : null);
          };
          req.onerror = () => resolve(null);
        } catch (_) {
          resolve(null);
        }
      });
    },

    /**
     * LRU方式で上限（MAX_TILES）を超えた古いタイルを自動削除
     */
    async _checkAndPurge() {
      if (!this._db) return;
      try {
        const tx = this._db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const countReq = store.count();

        countReq.onsuccess = () => {
          const count = countReq.result;
          if (count > MAX_TILES) {
            const deleteCount = count - MAX_TILES + 100; // まとめて100枚削除
            const index = store.index('timestamp');
            const curReq = index.openCursor();
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

    async clearCache() {
      if (!this._db) await this._dbPromise;
      if (!this._db) return;

      return new Promise((resolve, reject) => {
        try {
          const tx = this._db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          tx.oncomplete = () => {
            this.updateCacheStatsUI();
            resolve();
          };
          tx.onerror = (e) => reject(e);
        } catch (e) {
          reject(e);
        }
      });
    },

    async updateCacheStatsUI() {
      const statsEl = document.getElementById('offline-cache-stats');
      if (!statsEl || !this._db) return;

      try {
        const tx = this._db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const curReq = store.openCursor();
        let totalSize = 0;
        let count = 0;

        curReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            count++;
            totalSize += (cursor.value.size || 0);
            cursor.continue();
          } else {
            const mb = (totalSize / (1024 * 1024)).toFixed(1);
            statsEl.textContent = `${count} タイル (${mb} MB)`;
          }
        };
      } catch (_) {
        statsEl.textContent = '0 タイル (0 MB)';
      }
    }
  };

})(window.GIS = window.GIS || {});
