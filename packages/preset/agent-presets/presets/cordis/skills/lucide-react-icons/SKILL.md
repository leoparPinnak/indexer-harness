---
name: lucide-react-icons
description: Standard icon kit guidelines for React/Vite/Next.js interfaces using lucide-react. Use when creating, redesigning, or modifying React UIs, dashboards, controls, and components that require icons, cyber/neon styling, or visual feedback.
---

# Lucide Icons (lucide-react) Icon Kit Standard

Bu yetenek (skill), DeepSeek Harness (DSH v2) ortamında üretilen veya düzenlenen tüm **React tabanlı web arayüzlerinde (Vite, Next.js, CRA, Tailwind CSS)** standart ikon kiti olarak **`lucide-react`** kütüphanesinin kullanılmasını ve modern görsel kalıplarla uygulanmasını kurala bağlar.

---

## 1. Temel Kural ve Standart

1. **Tek Standart:** React kullanılan tüm projelerde ikon ihtiyacı için harici, hantal veya eski paketler (`react-icons`, `font-awesome` vb.) yerine **`lucide-react`** kullanılmalıdır.
2. **Doğrudan Named Import:** Ağır paket yüklemelerini önlemek ve Vite/Webpack tree-shaking mekanizmasını %100 çalıştırmak için ikonlar doğrudan ana modülden named import ile alınır:
   ```tsx
   import { Server, Shield, Monitor, Lock, Flame } from 'lucide-react';
   ```
3. **Saf Vektörel & Sıfır Bağımlılık:** Lucide ikonları saf SVG elementleridir; doğrudan CSS, Tailwind sınıfları ve animasyonlarla tam uyumludur.

---

## 2. Kurulum

Yeni bir React projesine başlandığında veya mevcut projeye eklenirken:

```bash
# pnpm ile (Önerilen)
pnpm add lucide-react

# npm veya yarn ile
npm install lucide-react
# veya
yarn add lucide-react
```

---

## 3. Tailwind CSS & Siber/Neon İkon Tasarım Kalıpları

Lucide ikonları `className` prop'u üzerinden doğrudan biçimlendirilir.

### Boyutlandırma Standartları
- **Mikro / Buton İçi:** `w-3.5 h-3.5` veya `w-4 h-4` (ör. `<Play className="w-4 h-4" />`)
- **Standart Başlık / Rozet:** `w-5 h-5` (ör. `<Radio className="w-5 h-5" />`)
- **Büyük / Düğüm / Kart Simgesi:** `w-6 h-6` veya `w-8 h-8` (ör. `<Server className="w-6 h-6" />`)

### Siber Neon Cam Kapsayıcı Kalıbı (Glassmorphism Cyber Badge)
Arayüzlerde ikonları şık, yarı saydam ve arkaya ışıma yapan modern siber kutucuklar içine yerleştirmek için şu kalıp kullanılır:

```tsx
{/* Mavi İstemci / Monitör Kutusu */}
<div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 shadow-md shadow-blue-500/10 flex items-center justify-center">
  <Monitor className="w-6 h-6 text-blue-400" />
</div>

{/* Yeşil Canlı Sunucu Kutusu */}
<div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 shadow-md shadow-emerald-500/20 flex items-center justify-center">
  <Server className="w-6 h-6 text-emerald-400" />
</div>

{/* Mor Tor / Onion Alev Kutusu (Animasyonlu) */}
<div className="w-12 h-12 rounded-xl bg-purple-500/20 border border-purple-500/40 shadow-md shadow-purple-500/30 flex items-center justify-center animate-pulse">
  <Flame className="w-6 h-6 text-purple-300" />
</div>

{/* Kehribar Güvenlik Kalkanı Kutusu */}
<div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 shadow-md shadow-amber-500/20 flex items-center justify-center">
  <Shield className="w-6 h-6 text-amber-400" />
</div>
```

---

## 4. Sık Kullanılan İkonlar Kataloğu (Kategoriye Göre)

### Ağ, Altyapı ve Sistemler
- `Server` — Sunucu, arka uç, dinleyici port
- `Monitor` — İstemci, tarayıcı, masaüstü
- `Radio` — Canlı akış, SSE, radyo dalgası, tünel
- `Globe` — Dünya, internet, hedef adres
- `Cpu` — İşlemci, çekirdek, donanım performansı
- `Activity` — Ağ trafiği, grafik, kalp atışı
- `Layers` — Katmanlar, çoklu hop, tünel mimarisi
- `HardDrive` — Depolama, yerel disk, profil dizini

### Güvenlik, Kilit ve Kimlik
- `Shield` — Güvenli vekil, koruma
- `ShieldCheck` — Doğrulanmış güvenlik
- `ShieldAlert` — Güvenlik alarmı, IP sızıntısı
- `Lock` — SEC kilitli mod, şifreleme
- `Unlock` — Kilit açık, serbest mod
- `Key` — Kimlik doğrulama, token, anahtar
- `Eye` / `EyeOff` — Şifre veya gizli veri göster/gizle
- `Fingerprint` — Parmak izi, anti-bot kontrolü

### Durum, Güç ve Enerji
- `Flame` — Tor ağı, yüksek performans
- `Zap` — Hızlı işlem, elektrik akışı, anlık tetik
- `Sparkles` — Özel profil, yapay zekâ, optimize özellik
- `Power` — Açma/kapama, sistem şalteri
- `Battery` — Enerji durumu

### Eylemler, Kontroller ve Bildirimler
- `Play` — Başlat, çalıştır
- `Square` — Durdur
- `RotateCw` / `RefreshCw` — Yenile, yeniden test et, radar taraması (`animate-spin` ile)
- `Send` — İstek gönder, paket ilet
- `Copy` — Kopyala
- `Check` / `CheckCircle2` — Başarılı, kopyalandı, aktif
- `AlertCircle` — Uyarı, eksik parametre
- `XCircle` — Hata, başarısız, ölü proxy
- `Plus` — Yeni profil / kayıt ekle
- `Trash2` — Sil, temizle
- `ExternalLink` — Dış bağlantı, yeni pencerede aç

---

## 5. Kaçınılması Gereken Hatalar (Anti-Patterns)

- ❌ Aynı projede `react-icons`, `@heroicons/react` ve `lucide-react`'i karıştırmayın; her zaman **`lucide-react`** tercih edin.
- ❌ İkonları `lucide-react/dist/...` gibi alt yollardan import etmeyin; doğrudan `lucide-react` kökünden alın.
- ❌ Kütüphanede hazır ikonu varken sayfaya onlarca satır statik, ham `<svg><path ... /></svg>` gömmeyin.
- ❌ Dönen buton ikonlarında `animate-spin` sınıfını koşullu verin:
  ```tsx
  <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
  ```
