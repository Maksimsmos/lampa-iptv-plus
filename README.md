# IPTV+ для Lampa

Независимый IPTV-плагин для Lampa 3.x. Он не использует CUB API и хранит адреса плейлиста/телегида локально в настройках Lampa.

## Возможности

- загрузка M3U/M3U8 по URL;
- группы каналов, логотипы и переключение каналов в IPTV-интерфейсе Lampa;
- XMLTV/EPG из настройки или атрибута `url-tvg`/`x-tvg-url` плейлиста;
- архив и «смотреть с начала» через `catchup`, `catchup-source`, `catchup-days`, `tvg-rec`, `timeshift`;
- схемы архива `default`, `append`, `shift`/`timeshift`, `flussonic`, `xc`/`xtream`;
- переменные `${start}`, `${end}`, `${utc}`, `${utcend}`, `${timestamp}`, `${offset}`, `${duration}`, `${durationfs}`;
- перемотка архивной передачи штатной шкалой плеера Lampa.

## Установка

1. Разместите `plugin.js` на HTTPS-хостинге с MIME-типом `text/javascript`. Подойдёт GitHub Pages, Cloudflare Pages или собственный веб-сервер.
2. В Lampa откройте **Настройки → Расширения → Добавить плагин**.
3. Введите полный HTTPS-адрес файла `plugin.js`.
4. Перезапустите Lampa.
5. Откройте **IPTV+**, нажмите **Плейлист** и укажите URL M3U/M3U8. Раздел **Настройки → IPTV+** остаётся дополнительным способом настройки, если он отображается в вашей сборке Lampa.
6. В главном меню появится пункт **IPTV+**.

Плагин использует плеер, выбранный в штатной настройке Lampa **Плеер для IPTV**.

Для временной проверки в локальной сети можно запустить сервер из каталога проекта:

```bash
python3 -m http.server 8080
```

Затем добавить в Lampa адрес вида `http://IP-КОМПЬЮТЕРА:8080/plugin.js`. Apple TV и компьютер должны находиться в одной сети. Для постоянного использования рекомендуется HTTPS.

## Пример плейлиста с архивом

```m3u
#EXTM3U url-tvg="https://example.org/epg.xml"
#EXTINF:-1 tvg-id="channel.one" tvg-logo="https://example.org/logo.png" group-title="Новости" catchup="append" catchup-days="7" catchup-source="?utc=${start}&lutc=${timestamp}",Первый канал
https://provider.example/live/1/index.m3u8
```

Для Flussonic:

```m3u
#EXTINF:-1 tvg-id="channel.two" group-title="Спорт" catchup="flussonic" catchup-days="3",Спорт
https://provider.example/sport/index.m3u8
```

## Ограничения Apple TV

- На предоставленном снимке Lampa сообщает `supports headers: false`. Поэтому потоки, требующие собственных `Referer`, `User-Agent`, cookies или Authorization, могут не открыться в системном плеере Apple TV.
- Плагин может перематывать архивную ссылку и HLS-поток с серверным DVR-окном. Он не может самостоятельно записывать и хранить прямой эфир на Apple TV.
- Архив существует только тогда, когда IPTV-провайдер хранит передачи и описывает способ построения архивной ссылки.
- Текущая версия принимает обычный XMLTV. Если телегид доступен только как файл `.xml.gz`, сервер должен отдавать его распакованным либо понадобится прокси.

Используйте только плейлисты и потоки, на просмотр которых у вас есть разрешение.
