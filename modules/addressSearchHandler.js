/**
 * addressSearchHandler.js - 上部切り替えバーの展開式・国土地理院住所検索機能
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

  GIS.AddressSearchHandler = {
    isOpen: false,
    _searchMarker: null,
    _debounceTimer: null,

    init: function () {
      this._bindEvents();
    },

    _bindEvents: function () {
      const toggleBtn = document.getElementById('btn-toggle-address-search');
      const searchBar = document.getElementById('address-search-bar');
      const input = document.getElementById('address-search-input');
      const clearBtn = document.getElementById('btn-address-search-clear');
      const submitBtn = document.getElementById('btn-address-search-submit');
      const resultsContainer = document.getElementById('address-search-results');

      if (!toggleBtn || !searchBar || !input) return;

      // 展開/折りたたみトグル
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });

      // 入力時の処理（デバウンス検索 & クリアボタン表示制御）
      input.addEventListener('input', () => {
        const val = input.value.trim();
        if (clearBtn) {
          clearBtn.classList.toggle('hidden', val.length === 0);
        }
        clearTimeout(this._debounceTimer);
        if (val.length >= 2) {
          this._debounceTimer = setTimeout(() => {
            this.search(val);
          }, 350);
        } else {
          this._hideResults();
        }
      });

      // Enterキーで即時検索
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input.value.trim();
          if (val) {
            clearTimeout(this._debounceTimer);
            this.search(val, true); // true = 1件目即座移動モード
          }
        } else if (e.key === 'Escape') {
          this._hideResults();
        }
      });

      // 検索ボタンクリック
      if (submitBtn) {
        submitBtn.addEventListener('click', () => {
          const val = input.value.trim();
          if (val) {
            this.search(val, true);
          }
        });
      }

      // クリアボタン
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          input.value = '';
          clearBtn.classList.add('hidden');
          this._hideResults();
          input.focus();
        });
      }

      // 検索バー外クリックで候補リストを閉じる
      document.addEventListener('click', (e) => {
        if (searchBar && !searchBar.contains(e.target)) {
          this._hideResults();
        }
      });
    },

    /**
     * 住所検索バーの開閉トグル
     */
    toggle: function () {
      const searchBar = document.getElementById('address-search-bar');
      const toggleBtn = document.getElementById('btn-toggle-address-search');
      const input = document.getElementById('address-search-input');
      const arrow = toggleBtn ? toggleBtn.querySelector('.search-toggle-arrow') : null;

      this.isOpen = !this.isOpen;

      if (searchBar) {
        searchBar.classList.toggle('expanded', this.isOpen);
        searchBar.classList.toggle('collapsed', !this.isOpen);
      }
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', String(this.isOpen));
        toggleBtn.classList.toggle('active', this.isOpen);
        if (arrow) {
          arrow.textContent = this.isOpen ? '◀' : '▶';
        }
      }

      if (this.isOpen) {
        setTimeout(() => {
          if (input) input.focus();
        }, 150);
      } else {
        this._hideResults();
      }
    },

    /**
     * 国土地理院住所検索APIの呼び出し
     * @param {string} query 
     * @param {boolean} autoSelectFirst 1件ヒット時に即座移動するか
     */
    search: async function (query, autoSelectFirst = false) {
      const resultsContainer = document.getElementById('address-search-results');
      if (!resultsContainer) return;

      try {
        // 国土地理院 住所検索API（CORS対応・認証不要）
        const url = `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        let items = [];
        if (res.ok) {
          items = await res.json();
        }

        // GSI APIでヒットしなかった場合、またはエラー時はOpenStreetMap Nominatimでフォールバック
        if (!Array.isArray(items) || items.length === 0) {
          try {
            const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=jp&limit=6`;
            const nomRes = await fetch(nomUrl, { headers: { 'Accept': 'application/json' } });
            if (nomRes.ok) {
              const nomData = await nomRes.json();
              if (Array.isArray(nomData) && nomData.length > 0) {
                items = nomData.map(item => ({
                  type: 'Feature',
                  geometry: {
                    type: 'Point',
                    coordinates: [parseFloat(item.lon), parseFloat(item.lat)]
                  },
                  properties: {
                    title: item.display_name
                  }
                }));
              }
            }
          } catch (nomErr) {
            console.warn('[AddressSearch] Nominatim fallback failed:', nomErr);
          }
        }

        if (!Array.isArray(items) || items.length === 0) {
          this._renderResults([], query);
          return;
        }

        // Enter等で1件のみヒット時、または確実に一致した場合は即座ジャンプ
        if (autoSelectFirst && items.length === 1) {
          this.selectLocation(items[0]);
          return;
        }

        this._renderResults(items.slice(0, 8), query);

      } catch (err) {
        console.warn('[AddressSearch] Search error:', err);
        this._renderError('住所検索に失敗しました。通信環境をご確認ください。');
      }
    },

    _renderResults: function (items, query) {
      const resultsContainer = document.getElementById('address-search-results');
      if (!resultsContainer) return;

      if (items.length === 0) {
        resultsContainer.innerHTML = `
          <div class="address-search-empty">
            「${escapeHtml(query)}」に一致する住所が見つかりませんでした
          </div>
        `;
        resultsContainer.classList.remove('hidden');
        return;
      }

      resultsContainer.innerHTML = items.map((item, idx) => {
        const title = item.properties && item.properties.title ? item.properties.title : '名称なし';
        return `
          <div class="address-search-item" data-idx="${idx}">
            <span class="search-item-icon">📍</span>
            <span class="search-item-title">${escapeHtml(title)}</span>
          </div>
        `;
      }).join('');

      resultsContainer.classList.remove('hidden');

      // 候補クリックイベントのバインド
      resultsContainer.querySelectorAll('.address-search-item').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.idx, 10);
          if (items[idx]) {
            this.selectLocation(items[idx]);
          }
        });
      });
    },

    _renderError: function (msg) {
      const resultsContainer = document.getElementById('address-search-results');
      if (!resultsContainer) return;
      resultsContainer.innerHTML = `<div class="address-search-error">${escapeHtml(msg)}</div>`;
      resultsContainer.classList.remove('hidden');
    },

    _hideResults: function () {
      const resultsContainer = document.getElementById('address-search-results');
      if (resultsContainer) {
        resultsContainer.classList.add('hidden');
        resultsContainer.innerHTML = '';
      }
    },

    /**
     * 選択した候補へマップを移動し、ハイライトピンを表示
     */
    selectLocation: function (feature) {
      const map = GIS.AppState.map;
      if (!map) return;

      const coords = feature.geometry && feature.geometry.coordinates;
      if (!coords || coords.length < 2) return;

      const lng = coords[0];
      const lat = coords[1];
      const title = feature.properties && feature.properties.title ? feature.properties.title : '検索地点';

      this._hideResults();

      // スムーズに飛行移動（ズームレベル16）
      map.flyTo([lat, lng], 16, {
        duration: 1.2
      });

      // 既存マーカーを削除
      if (this._searchMarker && map.hasLayer(this._searchMarker)) {
        map.removeLayer(this._searchMarker);
      }

      // ハイライトマーカーの生成
      const markerIcon = L.divIcon({
        className: 'address-search-marker-icon',
        html: `
          <div class="search-marker-pin">
            <span class="search-marker-pulse"></span>
            <span class="search-marker-core">📍</span>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 28],
        popupAnchor: [0, -28]
      });

      this._searchMarker = L.marker([lat, lng], { icon: markerIcon }).addTo(map);

      // ポップアップを開く
      const popupHtml = `
        <div class="address-search-popup">
          <div class="search-popup-badge">検索結果</div>
          <strong class="search-popup-title">${escapeHtml(title)}</strong>
          <div class="search-popup-coords">${lat.toFixed(5)}°, ${lng.toFixed(5)}°</div>
        </div>
      `;
      this._searchMarker.bindPopup(popupHtml, {
        closeButton: true,
        className: 'address-search-leaflet-popup'
      }).openPopup();

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`📍 「${title}」へ移動しました`, 'success');
      }
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    GIS.AddressSearchHandler.init();
  });

})(window.GIS = window.GIS || {});
