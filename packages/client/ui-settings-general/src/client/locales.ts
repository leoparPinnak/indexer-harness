/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'connection.error': '连接异常',
  'connection.retry': '立即重连',
  'connection.connecting': '自动重连中',
  'connection.connected': '连接成功',
  'connection.reconnect': '连接异常，点击立即重连',
  'connection.restart': '连接中断，正在自动重试，点击立即重连',
  'shutdown.trigger': '关闭服务',
  'shutdown.title': '关闭服务',
  'shutdown.description': '确定要关闭 Indexer Harness 服务器吗？这将终止服务进程。',
  'shutdown.confirm': '确认关闭',
  'shutdown.cancel': '取消',
  'shutdown.shuttingDown': '正在关闭...',
  'shutdown.completed': '服务已关闭，您可以关闭此浏览器标签页。',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'connection.error': 'Disconnected',
  'connection.retry': 'Reconnect now',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Reconnecting automatically, reconnect now',
  'shutdown.trigger': 'Shut Down',
  'shutdown.title': 'Shut Down Server',
  'shutdown.description': 'Are you sure you want to shut down the Indexer Harness server? This will terminate the server process.',
  'shutdown.confirm': 'Shut Down',
  'shutdown.cancel': 'Cancel',
  'shutdown.shuttingDown': 'Shutting down...',
  'shutdown.completed': 'Server has been shut down. You can now close this browser tab.',
} satisfies Record<SettingsKey, string>

/** Turkish dictionary, checked complete against the zh key set. */
export const tr = {
  'trigger': 'Ayarlar',
  'title': 'Ayarlar',
  'close': 'Kapat',
  'openDocument': 'Yapılandırma dosyasını aç',
  'openDocument.error': 'Yapılandırma dosyası açılamadı',
  'general.nav': 'Genel',
  'connection.error': 'Bağlantı kesildi',
  'connection.retry': 'Şimdi yeniden bağlan',
  'connection.connecting': 'Yeniden bağlanılıyor',
  'connection.connected': 'Bağlandı',
  'connection.reconnect': 'Bağlantı kesildi, şimdi yeniden bağlan',
  'connection.restart': 'Otomatik yeniden bağlanılıyor, şimdi yeniden bağlan',
  'shutdown.trigger': 'Sunucuyu Kapat',
  'shutdown.title': 'Sunucuyu Kapat',
  'shutdown.description': 'Indexer Harness sunucusunu kapatmak istediğinizden emin misiniz? Bu işlem sunucu sürecini sonlandıracaktır.',
  'shutdown.confirm': 'Kapat',
  'shutdown.cancel': 'İptal',
  'shutdown.shuttingDown': 'Kapatılıyor...',
  'shutdown.completed': 'Sunucu kapatıldı. Artık bu tarayıcı sekmesini kapatabilirsiniz.',
} satisfies Record<SettingsKey, string>

