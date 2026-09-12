/**
 * mobileGeolocationHandler.js - スマートフォン用コンパス・現在地取得・追尾管理
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

    init(map) {
      this._map = map;
      this._compassBtn = document.getElementById('btn-mobile-compass');
      if (!this._compassBtn) return;

      this._compassBtn.addEventListener('click', () => {
        this.toggle();
      });

      // 画面幅やタッチ環境に応じた表示制御
      this._updateVisibility();
      window.addEventListener('resize', () => this._updateVisibility());
    },

    _updateVisibility() {
      if (!this._compassBtn) return;
      const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
      this._compassBtn.style.display = isMobile ? 'flex' : 'none';
    },

    /**
     * コンパスボタン押下時の3段階状態トグル
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

      if (this._state === 1) {
        this._compassBtn.classList.add('state-location');
        this._compassBtn.title = '現在地表示中（クリックで追尾開始）';
      } else if (this._state === 2) {
        this._compassBtn.classList.add('state-tracking');
        this._compassBtn.title = '現在地追尾中（クリックで追尾停止）';
      } else {
        this._compassBtn.title = 'コンパス（クリックで現在地取得）';
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
