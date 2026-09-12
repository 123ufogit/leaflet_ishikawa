/**
 * mobileGeolocationHandler.js - スマートフォン用コンパス・現在地取得・追尾・トラッキング管理
 * GIS Browser - Leaflet WebGIS
 */
(function (GIS) {
  'use strict';

  GIS.MobileGeolocationHandler = {
    _map: null,
    _compassBtn: null,
    _state: 0, // 0: 通常, 1: 現在地取得, 2: 追尾中
    _watchId: null,
    _marker: null,
    _accuracyCircle: null,
    _headingMarker: null,
    _lastLatLng: null,
    _orientationListener: null,

    // ===== トラッキング機能用プロパティ =====
    _isTrackingRecording: false, // トラッキング記録中フラグ
    _trackIntervalId: null,      // 10秒ごとのサンプリングタイマーID
    _trackLayerId: null,         // 現在のトラックレイヤーID (GIS.AppState)
    _currentTrackPolyline: null, // 現在記録中セグメントのポリライン (L.Polyline)
    _currentTrackLatLngs: [],    // 現在記録中セグメントの座標配列
    _beforeUnloadHandler: null,  // 離脱警告ハンドラ

    init(map) {
      this._map = map;
      this._compassBtn = document.getElementById('btn-mobile-compass');
      if (!this._compassBtn) return;

      // 2秒長押し（トラッキング開始/停止）および短押し（現在地/追尾トグル）のバインド
      this._bindCompassEvents();

      // レイヤー削除時の監視（トラックレイヤが削除された場合は追従リセット）
      if (GIS.AppState && typeof GIS.AppState.on === 'function') {
        GIS.AppState.on('layerRemoved', ({ id }) => {
          if (id === this._trackLayerId) {
            this._trackLayerId = null;
            this._currentTrackPolyline = null;
            this._currentTrackLatLngs = [];
          }
        });
      }

      // 画面幅やタッチ環境に応じた表示制御
      this._updateVisibility();
      window.addEventListener('resize', () => this._updateVisibility());
    },

    _updateVisibility() {
      if (!this._compassBtn) return;
      // iPad（11インチ 834x1194等）、タブレット、スマホ、タッチ端末、PCすべてで常に利用可能にする
      this._compassBtn.style.display = 'flex';
    },

    /**
     * コンパスボタンのイベントバインド（短押し＝現在地トグル、2秒長押し＝トラッキング開始/停止）
     */
    _bindCompassEvents() {
      if (!this._compassBtn) return;

      // iPad / iOS Safari での長押し時コンテキストメニュー抑止
      this._compassBtn.addEventListener('contextmenu', (e) => e.preventDefault());

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
        this._compassBtn.classList.remove('is-pressing-compass');
      };

      const startPress = (clientX, clientY) => {
        isLongPressed = false;
        startX = clientX;
        startY = clientY;
        this._compassBtn.classList.add('is-pressing-compass');

        timer = setTimeout(() => {
          isLongPressed = true;
          this._compassBtn.classList.remove('is-pressing-compass');
          this._compassBtn.classList.add('track-triggered');
          setTimeout(() => {
            if (this._compassBtn) this._compassBtn.classList.remove('track-triggered');
          }, 500);

          if (navigator.vibrate) {
            try { navigator.vibrate([100, 50, 100]); } catch (_) {}
          }

          // トラッキング記録の開始 / 停止を切替
          this.toggleTrackingRecord();
          timer = null;
        }, LONG_PRESS_DURATION);
      };

      // マウスイベント
      this._compassBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        startPress(e.clientX, e.clientY);
      });

      this._compassBtn.addEventListener('mousemove', (e) => {
        if (!timer) return;
        if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) {
          cancelPress();
        }
      });

      this._compassBtn.addEventListener('mouseup', cancelPress);
      this._compassBtn.addEventListener('mouseleave', cancelPress);

      // タッチイベント
      this._compassBtn.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { cancelPress(); return; }
        const t = e.touches[0];
        startPress(t.clientX, t.clientY);
      }, { passive: true });

      this._compassBtn.addEventListener('touchmove', (e) => {
        if (!timer || e.touches.length !== 1) { cancelPress(); return; }
        const t = e.touches[0];
        if (Math.abs(t.clientX - startX) > 12 || Math.abs(t.clientY - startY) > 12) {
          cancelPress();
        }
      }, { passive: true });

      this._compassBtn.addEventListener('touchend', cancelPress);
      this._compassBtn.addEventListener('touchcancel', cancelPress);

      // 短押しクリック時: 通常の現在地/追尾トグル（長押し時は抑止）
      this._compassBtn.addEventListener('click', (e) => {
        if (isLongPressed) {
          e.preventDefault();
          e.stopPropagation();
          isLongPressed = false;
          return;
        }
        this.toggle();
      });
    },

    /**
     * コンパスボタン押下時の3段階状態トグル（短押し用）
     */
    toggle() {
      // セキュアコンテキスト（HTTPS / localhost）の確認
      const isSecure = window.isSecureContext ||
                       location.protocol === 'https:' ||
                       location.hostname === 'localhost' ||
                       location.hostname === '127.0.0.1';

      if (!isSecure && location.protocol === 'file:') {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('⚠️ 位置情報（GPS）の利用にはHTTPS環境またはローカルWebサーバーが必要です', 'warning');
        } else {
          alert('位置情報（GPS）の利用にはHTTPS環境またはローカルWebサーバーが必要です');
        }
        return;
      }

      if (!('geolocation' in navigator)) {
        if (GIS.UI && GIS.UI.showToast) {
          GIS.UI.showToast('⚠️ お使いのブラウザは位置情報（GPS）に対応していません', 'warning');
        }
        return;
      }

      // 状態遷移: 0 -> 1 -> 2 -> 0
      if (this._state === 0) {
        this._state = 1;
        this._getCurrentLocation();
      } else if (this._state === 1) {
        this._state = 2;
        this._startTracking();
      } else {
        this._state = 0;
        this._stopTracking(true);
      }

      this._updateButtonUI();
    },

    /**
     * ボタンの見た目を状態に合わせて更新
     */
    _updateButtonUI() {
      if (!this._compassBtn) return;
      this._compassBtn.classList.remove('state-location', 'state-tracking');

      let modeDesc = '';
      if (this._state === 1) {
        this._compassBtn.classList.add('state-location');
        modeDesc = '現在地表示中';
      } else if (this._state === 2) {
        this._compassBtn.classList.add('state-tracking');
        modeDesc = '現在地追尾中';
      } else {
        modeDesc = '通常';
      }

      const recDesc = this._isTrackingRecording ? '【🔴トラック記録中】' : '';
      this._compassBtn.title = `コンパス（${modeDesc}${recDesc} / タップ: 現在地・追尾 / 2秒長押し: トラック記録開始・停止）`;
    },

    // ==========================================================
    // トラッキング記録機能（10秒間隔・同日レイヤ追記・離脱警告）
    // ==========================================================

    /**
     * トラッキング記録の開始 / 停止をトグル
     */
    toggleTrackingRecord() {
      if (this._isTrackingRecording) {
        this.stopTrackingRecord(true);
      } else {
        this.startTrackingRecord();
      }
    },

    /**
     * トラックレイヤ名を取得（トラック＋日付、例: トラック20260912）
     * @returns {string}
     */
    _getTodayTrackLayerName() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `トラック${y}${m}${day}`;
    },

    /**
     * 今日のトラックレイヤーを取得、なければ新規作成して AppState に登録
     * 複数回のトラッキングセッションを同じレイヤーに記録
     * @returns {object} AppState layer entry
     */
    _getOrCreateTrackLayer() {
      const layerName = this._getTodayTrackLayerName();

      // 1. 既存のトラックレイヤーがあるか確認
      let trackEntry = null;
      if (this._trackLayerId && GIS.AppState.layers.has(this._trackLayerId)) {
        trackEntry = GIS.AppState.layers.get(this._trackLayerId);
      } else {
        for (const [id, entry] of GIS.AppState.layers.entries()) {
          if (entry.name === layerName && entry.type === 'track') {
            trackEntry = entry;
            this._trackLayerId = id;
            break;
          }
        }
      }

      if (trackEntry) {
        // レイヤーが非表示になっていたら表示状態に戻す
        if (!trackEntry.visible) {
          GIS.AppState.toggleLayer(trackEntry.id);
        }
        return trackEntry;
      }

      // 2. 新規トラックレイヤーを作成
      const featureGroup = L.featureGroup();
      const initialGeoJSON = {
        type: 'FeatureCollection',
        features: []
      };

      const id = GIS.AppState.addLayer({
        name: layerName,
        type: 'track',
        layer: featureGroup,
        rawGeoJSON: initialGeoJSON,
        isUnsaved: true
      });

      this._trackLayerId = id;
      return GIS.AppState.layers.get(id);
    },

    /**
     * トラッキング記録を開始する
     */
    startTrackingRecord() {
      this._isTrackingRecording = true;
      if (this._compassBtn) {
        this._compassBtn.classList.add('is-recording-track');
      }
      this._updateButtonUI();

      // ページ離脱・リロード前の警告を設定
      if (!this._beforeUnloadHandler) {
        this._beforeUnloadHandler = (e) => {
          e.preventDefault();
          e.returnValue = 'GPSトラック記録中です。ページをリロードまたは移動すると記録が停止します。';
          return e.returnValue;
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);
      }

      // レイヤーと新規セグメントポリラインを準備
      const trackEntry = this._getOrCreateTrackLayer();
      const group = trackEntry.layer;

      this._currentTrackLatLngs = [];
      this._currentTrackPolyline = L.polyline([], {
        color: '#06b6d4',
        weight: 5,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(group);

      const layerName = trackEntry.name;
      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast(`🔴 トラッキングを開始しました（10秒間隔・「${layerName}」に記録）`, 'success');
      }

      // GPS位置情報が利用可能な場合はサンプリングを開始（10秒間隔）
      if ('geolocation' in navigator) {
        this._recordPositionSample();

        if (this._trackIntervalId) clearInterval(this._trackIntervalId);
        this._trackIntervalId = setInterval(() => {
          this._recordPositionSample();
        }, 10000);
      }
    },

    /**
     * トラッキング記録を停止する
     * @param {boolean} showToast
     */
    stopTrackingRecord(showToast = true) {
      if (!this._isTrackingRecording) return;

      this._isTrackingRecording = false;
      if (this._trackIntervalId) {
        clearInterval(this._trackIntervalId);
        this._trackIntervalId = null;
      }

      // 離脱警告の解除
      if (this._beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        this._beforeUnloadHandler = null;
      }

      if (this._compassBtn) {
        this._compassBtn.classList.remove('is-recording-track');
      }
      this._updateButtonUI();

      const pointCount = this._currentTrackLatLngs ? this._currentTrackLatLngs.length : 0;
      this._syncTrackGeoJSON();

      if (showToast && GIS.UI && GIS.UI.showToast) {
        const layerName = this._getTodayTrackLayerName();
        GIS.UI.showToast(`⏹️ トラッキングを停止しました（セッション記録: ${pointCount}点・「${layerName}」）`, 'info');
      }
    },

    /**
     * GPS位置情報を取得し、現在のトラックセグメントに追加（10秒サンプリング）
     */
    _recordPositionSample() {
      if (!this._isTrackingRecording) return;
      if (!('geolocation' in navigator)) return;

      const options = {
        enableHighAccuracy: true,
        timeout: 9500,
        maximumAge: 0
      };

      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (!this._isTrackingRecording) return;

            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            const alt = pos.coords.altitude;
            const accuracy = pos.coords.accuracy;
            const latlng = L.latLng(lat, lng);
            const timestamp = new Date().toISOString();

            this._currentTrackLatLngs.push({
              lat: lat,
              lng: lng,
              alt: alt,
              accuracy: accuracy,
              timestamp: timestamp
            });

            // ポリライン更新
            if (this._currentTrackPolyline) {
              const rawPoints = this._currentTrackLatLngs.map(p => [p.lat, p.lng]);
              this._currentTrackPolyline.setLatLngs(rawPoints);
            }

            // 現在地マーカーも更新（表示中であれば）
            if (this._marker || this._state > 0) {
              this._updateLocationMarker(latlng, accuracy);
            }

            // 内部 GeoJSON を同期
            this._syncTrackGeoJSON();
          },
          (err) => {
            console.warn('[Tracking] GPS sample notice:', err && err.message ? err.message : err);
          },
          options
        );
      } catch (e) {
        console.warn('[Tracking] Geolocation API call caught:', e);
      }
    },

    /**
     * トラックレイヤの rawGeoJSON を同期更新
     */
    _syncTrackGeoJSON() {
      if (!this._trackLayerId || !GIS.AppState.layers.has(this._trackLayerId)) return;
      const entry = GIS.AppState.layers.get(this._trackLayerId);
      if (!entry) return;

      const features = [];
      const group = entry.layer;

      if (group && typeof group.eachLayer === 'function') {
        let segIdx = 1;
        group.eachLayer((child) => {
          if (child instanceof L.Polyline && !(child instanceof L.Polygon)) {
            const latlngs = child.getLatLngs();
            if (latlngs && latlngs.length >= 2) {
              const coords = latlngs.map(ll => [ll.lng, ll.lat]);
              features.push({
                type: 'Feature',
                geometry: {
                  type: 'LineString',
                  coordinates: coords
                },
                properties: {
                  name: `${entry.name}_セグメント${segIdx}`,
                  layerName: entry.name,
                  pointCount: coords.length,
                  updatedAt: new Date().toISOString()
                }
              });
              segIdx++;
            } else if (latlngs && latlngs.length === 1) {
              features.push({
                type: 'Feature',
                geometry: {
                  type: 'Point',
                  coordinates: [latlngs[0].lng, latlngs[0].lat]
                },
                properties: {
                  name: `${entry.name}_セグメント${segIdx}`,
                  layerName: entry.name,
                  updatedAt: new Date().toISOString()
                }
              });
              segIdx++;
            }
          }
        });
      }

      entry.rawGeoJSON = {
        type: 'FeatureCollection',
        features: features
      };
      entry.isUnsaved = true;

      // レイヤーリストの「未保存」状態バッジを更新
      if (GIS.FloatingPanel && typeof GIS.FloatingPanel.updateLayerItemStatus === 'function') {
        GIS.FloatingPanel.updateLayerItemStatus(entry.id);
      }
    },

    /**
     * 1回目押下: 単発の現在地取得
     */
    _getCurrentLocation() {
      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('📡 GPS位置情報を取得中...', 'info');
      }

      const options = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      };

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const accuracy = pos.coords.accuracy;
          const latlng = L.latLng(lat, lng);
          this._lastLatLng = latlng;

          this._updateLocationMarker(latlng, accuracy);
          this._map.flyTo(latlng, Math.max(this._map.getZoom(), 16), { duration: 1.0 });

          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast(`📍 現在地を取得しました (精度: ±${Math.round(accuracy)}m)`, 'success');
          }
        },
        (err) => {
          console.warn('[Geolocation] Error:', err);
          this._state = 0;
          this._updateButtonUI();
          let msg = '⚠️ 位置情報の取得に失敗しました';
          if (err.code === 1) msg = '⚠️ 位置情報の利用が許可されていません';
          else if (err.code === 3) msg = '⚠️ 位置情報の取得がタイムアウトしました';
          if (GIS.UI && GIS.UI.showToast) {
            GIS.UI.showToast(msg, 'warning');
          }
        },
        options
      );
    },

    /**
     * 2回目押下: リアルタイム追尾開始
     */
    _startTracking() {
      const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 1000
      };

      this._watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (this._state !== 2) return;
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const accuracy = pos.coords.accuracy;
          const latlng = L.latLng(lat, lng);
          this._lastLatLng = latlng;

          this._updateLocationMarker(latlng, accuracy);
          this._map.panTo(latlng, { animate: true, duration: 0.5 });
        },
        (err) => {
          console.warn('[Geolocation] Tracking error:', err);
        },
        options
      );

      // 方位センサーの開始（利用可能な場合）
      this._startOrientation();

      if (GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('🧭 現在地を追尾中（移動に合わせて地図が追従します）', 'info');
      }
    },

    /**
     * 3回目押下: 追尾停止・リセット
     */
    _stopTracking(showToast = false) {
      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      this._stopOrientation();

      if (this._marker) {
        this._map.removeLayer(this._marker);
        this._marker = null;
      }
      if (this._accuracyCircle) {
        this._map.removeLayer(this._accuracyCircle);
        this._accuracyCircle = null;
      }
      if (this._headingMarker) {
        this._map.removeLayer(this._headingMarker);
        this._headingMarker = null;
      }

      this._state = 0;
      this._updateButtonUI();

      if (showToast && GIS.UI && GIS.UI.showToast) {
        GIS.UI.showToast('⏹️ 現在地の追尾を停止しました', 'info');
      }
    },

    /**
     * 青い円マーカー（L.circleMarker）および精度円の描画更新
     */
    _updateLocationMarker(latlng, accuracy) {
      if (!this._map) return;

      // 1. 測位精度範囲円（薄い青）
      if (!this._accuracyCircle) {
        this._accuracyCircle = L.circle(latlng, {
          radius: accuracy || 20,
          color: '#2563eb',
          weight: 1,
          opacity: 0.5,
          fillColor: '#3b82f6',
          fillOpacity: 0.15,
          interactive: false
        }).addTo(this._map);
      } else {
        this._accuracyCircle.setLatLng(latlng);
        this._accuracyCircle.setRadius(accuracy || 20);
      }

      // 2. 現在地本体の青い円マーカー
      if (!this._marker) {
        this._marker = L.circleMarker(latlng, {
          radius: 8,
          color: '#ffffff',
          weight: 2.5,
          fillColor: '#2563eb',
          fillOpacity: 1.0,
          className: 'mobile-current-location-marker'
        }).addTo(this._map);

        this._marker.bindPopup(`
          <div style="font-size:12px; line-height:1.5;">
            <strong style="color:#2563eb;">📍 現在地</strong><br>
            精度: ±${Math.round(accuracy)}m<br>
            緯度: ${latlng.lat.toFixed(6)}<br>
            経度: ${latlng.lng.toFixed(6)}
          </div>
        `, { maxWidth: 200 });
      } else {
        this._marker.setLatLng(latlng);
        this._marker.setPopupContent(`
          <div style="font-size:12px; line-height:1.5;">
            <strong style="color:#2563eb;">📍 現在地</strong><br>
            精度: ±${Math.round(accuracy)}m<br>
            緯度: ${latlng.lat.toFixed(6)}<br>
            経度: ${latlng.lng.toFixed(6)}
          </div>
        `);
      }
    },

    /**
     * デバイス方位（コンパス向き）の監視
     */
    _startOrientation() {
      if (typeof window.DeviceOrientationEvent === 'undefined') return;

      this._orientationListener = (e) => {
        let heading = e.webkitCompassHeading || e.alpha;
        if (heading == null) return;
        if (e.webkitCompassHeading) {
          // iOS Safari
        } else if (e.absolute && e.alpha) {
          heading = 360 - e.alpha; // Android
        }

        if (this._marker) {
          const el = this._marker.getElement();
          if (el) {
            el.style.transformOrigin = 'center center';
          }
        }
      };

      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+
        DeviceOrientationEvent.requestPermission()
          .then((res) => {
            if (res === 'granted') {
              window.addEventListener('deviceorientation', this._orientationListener, true);
            }
          })
          .catch(() => {});
      } else {
        window.addEventListener('deviceorientation', this._orientationListener, true);
      }
    },

    _stopOrientation() {
      if (this._orientationListener) {
        window.removeEventListener('deviceorientation', this._orientationListener, true);
        this._orientationListener = null;
      }
    }
  };

})(window.GIS = window.GIS || {});
