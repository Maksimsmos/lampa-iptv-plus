(function () {
    'use strict';

    if (window.lampa_iptv_plus_ready) return;
    window.lampa_iptv_plus_ready = true;

    var PLUGIN = 'iptv_plus';
    var VERSION = '1.0.0';
    var AUTO_EPG_URL = 'https://cdn.epg.one/edem.xml.gz';
    var AUTO_EPG_RU_URL = 'https://cdn.epg.one/ru.xml.gz';
    var AUTO_EPG_LITE_URL = 'https://cdn.epg.one/epg.xml';
    var CHANNEL_PAGE_SIZE = 80;
    var network = new Lampa.Reguest();
    var state = {
        channels: [],
        visible: [],
        groups: [],
        epg: {},
        epgNames: {},
        playlistEpg: '',
        archiveHint: false,
        autoEpg: false,
        guideMode: 'none',
        guideLoading: false,
        guidePromise: null,
        guideTicket: 0,
        archiveLoading: {},
        archiveReady: {},
        selectedChannel: '',
        selectedDay: '',
        loadedAt: 0,
        component: null
    };

    var ICON = '<svg height="36" viewBox="0 0 38 36" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="34" height="23" rx="4" stroke="currentColor" stroke-width="3"/><path d="M14 2l4 5 6-5" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M10 34h18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

    function text(value) {
        return value == null ? '' : String(value);
    }

    function escapeHtml(value) {
        return text(value).replace(/[&<>"']/g, function (character) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[character];
        });
    }

    function normalizeExact(value) {
        return text(value)
            .toLowerCase()
            .replace(/[ё]/g, 'е')
            .replace(/[^a-zа-я0-9]+/gi, ' ')
            .trim();
    }

    function normalize(value) {
        return normalizeExact(value)
            .replace(/\b(hd|fhd|uhd|4k|sd)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function rememberGuideName(target, name, id) {
        var exact = normalizeExact(name);
        var relaxed = normalize(name);
        if (exact && !target['exact:' + exact]) target['exact:' + exact] = id;
        if (relaxed && !target['relaxed:' + relaxed]) target['relaxed:' + relaxed] = id;
    }

    function storage(name, fallback) {
        return Lampa.Storage.get(PLUGIN + '_' + name, fallback);
    }

    function field(name) {
        return Lampa.Storage.field(PLUGIN + '_' + name);
    }

    function notify(message) {
        Lampa.Noty.show(message);
    }

    function channelKey(channel) {
        if (channel.id) return 'id:' + channel.id;
        return 'name:' + normalizeExact(channel.name) + ':' + normalizeExact(channel.group);
    }

    function legacyChannelKey(channel) {
        return channel.url ? 'url:' + channel.url : '';
    }

    function favoriteIds() {
        var saved = storage('favorites', []);
        return Array.isArray(saved) ? saved : [];
    }

    function isFavorite(channel) {
        var favorites = favoriteIds();
        return favorites.indexOf(channelKey(channel)) >= 0 || (legacyChannelKey(channel) && favorites.indexOf(legacyChannelKey(channel)) >= 0);
    }

    function setFavorite(channel, enabled) {
        var key = channelKey(channel);
        var legacy = legacyChannelKey(channel);
        var favorites = favoriteIds().filter(function (item) { return item !== key && item !== legacy; });
        if (enabled) favorites.unshift(key);
        Lampa.Storage.set(PLUGIN + '_favorites', favorites);
        if (state.component && state.component.onFavoritesChanged) state.component.onFavoritesChanged();
        return enabled;
    }

    function historyIds() {
        var saved = storage('history', []);
        return Array.isArray(saved) ? saved : [];
    }

    function addToHistory(channel) {
        var key = channelKey(channel);
        var history = historyIds().filter(function (item) { return item !== key; });
        history.unshift(key);
        Lampa.Storage.set(PLUGIN + '_history', history.slice(0, 40));
        Lampa.Storage.set(PLUGIN + '_last_channel', key);
        if (state.component) {
            state.component.historyDirty = true;
            if (!state.component.detailChannel && state.component.build) {
                state.component.historyDirty = false;
                state.component.build();
            }
        }
    }

    function historyChannels() {
        var order = historyIds();
        var channels = {};
        state.channels.forEach(function (channel) { channels[channelKey(channel)] = channel; });
        return order.map(function (key) { return channels[key]; }).filter(Boolean);
    }

    function requestText(url) {
        return new Promise(function (resolve, reject) {
            if (!url) return reject(new Error('URL не указан'));

            network.timeout(30000);
            network.native(url, function (data) {
                if (typeof data === 'string') resolve(data);
                else if (data && typeof data.responseText === 'string') resolve(data.responseText);
                else reject(new Error('Сервер вернул не текстовый документ'));
            }, function (error) {
                reject(error instanceof Error ? error : new Error('Не удалось загрузить ' + url));
            }, false, { dataType: 'text' });
        });
    }

    function attr(source, name) {
        var match = new RegExp('(?:^|\\s)' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '=(?:"([^"]*)"|\'([^\']*)\'|([^\\s]+))', 'i').exec(source);
        return match ? (match[1] || match[2] || match[3] || '') : '';
    }

    function splitUrlHeaders(source) {
        var parts = text(source).split('|');
        var headers = {};

        if (parts.length > 1) {
            parts.slice(1).join('|').split('&').forEach(function (pair) {
                var index = pair.indexOf('=');
                if (index > 0) headers[decodeURIComponent(pair.slice(0, index))] = decodeURIComponent(pair.slice(index + 1));
            });
        }

        return { url: parts[0].trim(), headers: headers };
    }

    function parseM3U(source) {
        source = text(source).replace(/^\uFEFF/, '');
        if (!/^#EXTM3U/i.test(source.trim())) throw new Error('Файл не похож на M3U-плейлист');

        var lines = source.split(/\r?\n/);
        var header = lines[0] || '';
        var headerCatchup = {
            type: attr(header, 'catchup'),
            source: attr(header, 'catchup-source'),
            days: attr(header, 'catchup-days') || attr(header, 'tvg-rec') || attr(header, 'timeshift'),
            rec: attr(header, 'tvg-rec')
        };
        var epgUrl = attr(header, 'url-tvg') || attr(header, 'x-tvg-url');
        var channels = [];
        var pending = null;

        lines.slice(1).forEach(function (rawLine) {
            var line = rawLine.trim();
            if (!line) return;

            if (line.indexOf('#EXTINF:') === 0) {
                var comma = line.lastIndexOf(',');
                var channelName = comma >= 0 ? line.slice(comma + 1).trim() : 'Без названия';
                var recDays = attr(line, 'tvg-rec') || headerCatchup.rec;
                var days = attr(line, 'catchup-days') || recDays || attr(line, 'timeshift') || headerCatchup.days;
                var type = attr(line, 'catchup') || headerCatchup.type;
                var sourceValue = attr(line, 'catchup-source') || headerCatchup.source;

                if (!type && sourceValue) type = /^https?:\/\//i.test(sourceValue) ? 'default' : 'append';
                if (!type && !sourceValue && recDays) type = 'shift';

                pending = {
                    id: attr(line, 'tvg-id'),
                    tvgName: attr(line, 'tvg-name'),
                    name: channelName,
                    logo: attr(line, 'tvg-logo'),
                    group: attr(line, 'group-title') || 'Без группы',
                    url: '',
                    headers: {},
                    catchup: {
                        type: type,
                        source: sourceValue,
                        days: Math.max(0, parseInt(days || field('archive_days') || 3, 10) || 0)
                    }
                };
                return;
            }

            if (!pending) return;

            if (line.indexOf('#EXTGRP:') === 0) {
                pending.group = line.slice(8).trim() || pending.group;
            } else if (line.indexOf('#EXTVLCOPT:') === 0) {
                var option = line.slice(11);
                var optionIndex = option.indexOf('=');
                if (optionIndex > 0) pending.headers[option.slice(0, optionIndex).trim()] = option.slice(optionIndex + 1).trim();
            } else if (line.charAt(0) !== '#') {
                var parsedUrl = splitUrlHeaders(line);
                pending.url = parsedUrl.url;
                Object.keys(parsedUrl.headers).forEach(function (key) { pending.headers[key] = parsedUrl.headers[key]; });

                if (pending.url) {
                    pending.index = channels.length;
                    channels.push(pending);
                }
                pending = null;
            }
        });

        return {
            channels: channels,
            epgUrl: epgUrl,
            archiveHint: channels.some(function (channel) {
                return channel.catchup.days > 0 || Boolean(channel.catchup.type || channel.catchup.source);
            })
        };
    }

    function parseXmltvDate(value) {
        var match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?/.exec(text(value));
        if (!match) return 0;

        if (!match[7]) {
            return new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0)).getTime();
        }

        var utc = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] || 0));
        var offset = ((+match[8] * 60) + (+match[9])) * 60000;
        return utc - (match[7] === '+' ? offset : -offset);
    }

    function childText(node, tag) {
        var child = node.getElementsByTagName(tag)[0];
        return child ? text(child.textContent).trim() : '';
    }

    function parseXmltv(source) {
        var documentXml = new DOMParser().parseFromString(text(source), 'text/xml');
        if (documentXml.getElementsByTagName('parsererror').length) throw new Error('Ошибка разбора XMLTV');

        var epg = {};
        var epgNames = {};
        var channelNodes = documentXml.getElementsByTagName('channel');
        var programNodes = documentXml.getElementsByTagName('programme');
        var keepAfter = Date.now() - ((parseInt(field('archive_days') || 3, 10) + 1) * 86400000);
        var keepBefore = Date.now() + (2 * 86400000);
        var i;

        for (i = 0; i < channelNodes.length; i++) {
            var id = channelNodes[i].getAttribute('id') || '';
            var displays = channelNodes[i].getElementsByTagName('display-name');
            for (var displayIndex = 0; id && displayIndex < displays.length; displayIndex++) {
                rememberGuideName(epgNames, text(displays[displayIndex].textContent).trim(), id);
            }
        }

        for (i = 0; i < programNodes.length; i++) {
            var node = programNodes[i];
            var channelId = node.getAttribute('channel') || '';
            var start = parseXmltvDate(node.getAttribute('start'));
            var stop = parseXmltvDate(node.getAttribute('stop'));
            if (!channelId || !start || !stop || stop < keepAfter || start > keepBefore) continue;

            if (!epg[channelId]) epg[channelId] = [];
            epg[channelId].push({
                start: start,
                stop: stop,
                title: childText(node, 'title') || 'Без названия',
                desc: childText(node, 'desc'),
                category: childText(node, 'category')
            });
        }

        Object.keys(epg).forEach(function (id) {
            epg[id].sort(function (a, b) { return a.start - b.start; });
        });

        return { epg: epg, names: epgNames };
    }

    function decodeXml(value) {
        return text(value).replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (full, entity) {
            var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
            if (named[entity]) return named[entity];
            if (entity.indexOf('#x') === 0) return String.fromCharCode(parseInt(entity.slice(2), 16));
            if (entity.charAt(0) === '#') return String.fromCharCode(parseInt(entity.slice(1), 10));
            return full;
        }).trim();
    }

    function xmlAttribute(source, name) {
        var match = new RegExp('(?:^|\\s)' + name + '=(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(source);
        return match ? decodeXml(match[1] || match[2] || '') : '';
    }

    function xmlValues(source, tag) {
        var values = [];
        var expression = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
        var match;
        while ((match = expression.exec(source))) values.push(decodeXml(match[1]));
        return values;
    }

    function parseXmltvStream(url, gzip, selectedChannels, timeout) {
        if (!window.fetch || !window.TextDecoder || (gzip && !window.DecompressionStream)) {
            return Promise.reject(new Error(gzip ? 'Распаковка XMLTV.GZ не поддерживается' : 'Потоковая загрузка XMLTV не поддерживается'));
        }

        var result = { epg: {}, names: {} };
        var wantedExactNames = {};
        var wantedNames = {};
        var wantedIds = {};
        var keepAfter = Date.now() - ((parseInt(field('archive_days') || 3, 10) + 1) * 86400000);
        var keepBefore = Date.now() + (2 * 86400000);

        (selectedChannels || state.channels).forEach(function (channel) {
            wantedExactNames[normalizeExact(channel.name)] = true;
            wantedNames[normalize(channel.name)] = true;
            if (channel.tvgName) {
                wantedExactNames[normalizeExact(channel.tvgName)] = true;
                wantedNames[normalize(channel.tvgName)] = true;
            }
            if (channel.id) wantedIds[channel.id] = true;
        });

        function accept(kind, attributes, body) {
            if (kind === 'channel') {
                var id = xmlAttribute(attributes, 'id');
                var names = xmlValues(body, 'display-name');
                var matched = names.some(function (name) {
                    return wantedExactNames[normalizeExact(name)] || wantedNames[normalize(name)];
                });
                if (!id || !matched) return;
                wantedIds[id] = true;
                names.forEach(function (name) { rememberGuideName(result.names, name, id); });
                return;
            }

            var channelId = xmlAttribute(attributes, 'channel');
            if (!wantedIds[channelId]) return;
            var start = parseXmltvDate(xmlAttribute(attributes, 'start'));
            var stop = parseXmltvDate(xmlAttribute(attributes, 'stop'));
            if (!start || !stop || stop < keepAfter || start > keepBefore) return;
            if (!result.epg[channelId]) result.epg[channelId] = [];
            result.epg[channelId].push({
                start: start,
                stop: stop,
                title: xmlValues(body, 'title')[0] || 'Без названия',
                desc: xmlValues(body, 'desc')[0] || '',
                category: xmlValues(body, 'category')[0] || ''
            });
        }

        var controller = window.AbortController ? new window.AbortController() : null;
        var timer;
        var timeoutPromise = new Promise(function (resolve, reject) {
            timer = setTimeout(function () {
                if (controller) controller.abort();
                reject(new Error('Загрузка телепрограммы превысила ' + Math.round((timeout || 45000) / 1000) + ' секунд'));
            }, timeout || 45000);
        });
        var options = controller ? { signal: controller.signal } : {};

        var loading = window.fetch(url, options).then(function (response) {
            if (!response.ok || !response.body) throw new Error('Не удалось загрузить автоматический EPG');
            var stream = gzip ? response.body.pipeThrough(new window.DecompressionStream('gzip')) : response.body;
            var reader = stream.getReader();
            var decoder = new window.TextDecoder('utf-8');
            var buffer = '';

            function consume(final) {
                var expression = /<(channel|programme)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
                var match;
                var consumed = 0;
                while ((match = expression.exec(buffer))) {
                    accept(match[1].toLowerCase(), match[2], match[3]);
                    consumed = expression.lastIndex;
                }
                if (consumed) buffer = buffer.slice(consumed);
                if (!final && buffer.length > 1048576) {
                    var channelStart = buffer.lastIndexOf('<channel');
                    var programStart = buffer.lastIndexOf('<programme');
                    var safeStart = Math.max(channelStart, programStart);
                    if (safeStart > 0) buffer = buffer.slice(safeStart);
                }
            }

            return new Promise(function (resolve, reject) {
                function read() {
                    reader.read().then(function (chunk) {
                        if (chunk.done) {
                            buffer += decoder.decode();
                            consume(true);
                            Object.keys(result.epg).forEach(function (id) {
                                result.epg[id].sort(function (a, b) { return a.start - b.start; });
                            });
                            clearTimeout(timer);
                            resolve(result);
                            return;
                        }
                        buffer += decoder.decode(chunk.value, { stream: true });
                        consume(false);
                        read();
                    }).catch(function (error) {
                        clearTimeout(timer);
                        reject(error);
                    });
                }
                read();
            });
        });

        return Promise.race([loading, timeoutPromise]).then(function (guide) {
            clearTimeout(timer);
            return guide;
        }).catch(function (error) {
            clearTimeout(timer);
            throw error;
        });
    }

    function parseXmltvGzip(url, selectedChannels, timeout) {
        return parseXmltvStream(url, true, selectedChannels, timeout);
    }

    function loadGuide(url, selectedChannels, timeout) {
        var gzip = /\.gz(?:$|[?#])/i.test(url);
        var canStream = window.fetch && window.TextDecoder && (!gzip || window.DecompressionStream);
        if (canStream) return parseXmltvStream(url, gzip, selectedChannels, timeout);
        if (gzip) return Promise.reject(new Error('Это устройство не поддерживает XMLTV.GZ'));
        return requestText(url).then(parseXmltv);
    }

    function mergeGuide(guide, replace) {
        if (replace) {
            state.epg = guide.epg || {};
            state.epgNames = guide.names || {};
            return;
        }

        Object.keys(guide.epg || {}).forEach(function (id) { state.epg[id] = guide.epg[id]; });
        Object.keys(guide.names || {}).forEach(function (name) { state.epgNames[name] = guide.names[name]; });
    }

    function refreshGuideUi() {
        if (!state.component) return;
        if (state.component.refreshOpenChannel && state.component.refreshOpenChannel()) return;
        if (state.component.build) state.component.build(true);
    }

    function startGuideLoad(url, automatic) {
        var ticket = ++state.guideTicket;
        state.guideLoading = true;
        state.guideMode = automatic ? 'today' : 'full';

        state.guidePromise = loadGuide(url, null, 45000).then(function (guide) {
            if (ticket !== state.guideTicket) return state;
            mergeGuide(guide, true);
            state.guideLoading = false;
            state.guidePromise = null;
            refreshGuideUi();
            return state;
        }).catch(function (error) {
            if (ticket !== state.guideTicket) return state;
            console.log('IPTV+', 'EPG load error', error);
            state.guideLoading = false;
            state.guidePromise = null;
            refreshGuideUi();
            notify(automatic ? 'Каналы загружены, но программа передач недоступна' : 'Каналы загружены, но XMLTV недоступен');
            return state;
        });

        return state.guidePromise;
    }

    function guideCacheKey(channel) {
        return normalizeExact(channel.name) + '|' + normalizeExact(channel.group);
    }

    function restoreArchiveGuide(channel) {
        var key = guideCacheKey(channel);
        if (state.archiveReady[key]) return true;
        var cache = storage('archive_cache', []);
        if (!Array.isArray(cache)) return false;
        var found = cache.filter(function (entry) {
            return entry && entry.key === key && entry.time > Date.now() - 21600000;
        })[0];
        if (!found || !found.guide) return false;
        mergeGuide(found.guide, false);
        state.archiveReady[key] = true;
        return true;
    }

    function saveArchiveGuide(channel, guide) {
        var key = guideCacheKey(channel);
        var cache = storage('archive_cache', []);
        if (!Array.isArray(cache)) cache = [];
        cache = cache.filter(function (entry) { return entry && entry.key !== key; });
        cache.unshift({ key: key, time: Date.now(), guide: guide });
        try {
            Lampa.Storage.set(PLUGIN + '_archive_cache', cache.slice(0, 10));
        } catch (error) {
            console.log('IPTV+', 'Archive cache save error', error);
        }
    }

    function loadArchiveGuide(channel) {
        var key = guideCacheKey(channel);
        if (state.guideMode === 'full' || restoreArchiveGuide(channel)) return Promise.resolve(state);
        if (state.archiveLoading[key]) return state.archiveLoading[key];

        var source = /[а-яё]/i.test(channel.name) ? AUTO_EPG_RU_URL : AUTO_EPG_URL;
        state.archiveLoading[key] = loadGuide(source, [channel], 60000).then(function (guide) {
            mergeGuide(guide, false);
            state.archiveReady[key] = true;
            saveArchiveGuide(channel, guide);
            delete state.archiveLoading[key];
            refreshGuideUi();
            return state;
        }).catch(function (error) {
            console.log('IPTV+', 'Archive guide load error', error);
            delete state.archiveLoading[key];
            throw error;
        });

        return state.archiveLoading[key];
    }

    function epgId(channel) {
        if (channel.id && state.epg[channel.id]) return channel.id;
        if (channel.tvgName && state.epgNames['exact:' + normalizeExact(channel.tvgName)]) return state.epgNames['exact:' + normalizeExact(channel.tvgName)];
        if (state.epgNames['exact:' + normalizeExact(channel.name)]) return state.epgNames['exact:' + normalizeExact(channel.name)];
        if (channel.tvgName && state.epgNames['relaxed:' + normalize(channel.tvgName)]) return state.epgNames['relaxed:' + normalize(channel.tvgName)];
        if (state.epgNames['relaxed:' + normalize(channel.name)]) return state.epgNames['relaxed:' + normalize(channel.name)];
        return channel.id || '';
    }

    function programs(channel) {
        return state.epg[epgId(channel)] || [];
    }

    function currentProgramIndex(channel, at) {
        at = at || Date.now();
        var list = programs(channel);
        for (var i = 0; i < list.length; i++) {
            if (list[i].start <= at && list[i].stop > at) return i;
        }
        return -1;
    }

    function programProgress(program, at) {
        if (!program || !program.start || !program.stop || program.stop <= program.start) return 0;
        at = at || Date.now();
        return Math.max(0, Math.min(100, Math.round(((at - program.start) / (program.stop - program.start)) * 100)));
    }

    function pad(value) {
        return ('0' + value).slice(-2);
    }

    function formatDate(timestamp, pattern, utc) {
        var date = new Date(timestamp * 1000);
        var get = function (localName, utcName) { return date[utc ? utcName : localName](); };
        var values = {
            yyyy: get('getFullYear', 'getUTCFullYear'),
            MM: pad(get('getMonth', 'getUTCMonth') + 1),
            dd: pad(get('getDate', 'getUTCDate')),
            HH: pad(get('getHours', 'getUTCHours')),
            mm: pad(get('getMinutes', 'getUTCMinutes')),
            ss: pad(get('getSeconds', 'getUTCSeconds'))
        };
        return text(pattern || 'yyyy-MM-dd:HH-mm').replace(/yyyy|MM|dd|HH|mm|ss/g, function (key) { return values[key]; });
    }

    function catchupTemplate(channel) {
        var type = text(channel.catchup.type).toLowerCase();
        var source = channel.catchup.source || '';
        var url = channel.url;

        if (!type) {
            if (source) type = /^https?:\/\//i.test(source) ? 'default' : 'append';
            else if (url.indexOf('${') >= 0) type = 'default';
            else if (channel.catchup.days > 0) type = 'shift';
            else return false;
        }

        if (type === 'disabled' || type === 'none') return false;
        if (type === 'default') {
            var defaultUrl = source || url;
            return defaultUrl.indexOf('${') >= 0 ? defaultUrl : defaultUrl + (defaultUrl.indexOf('?') >= 0 ? '&' : '?') + 'utc=${start}&lutc=${timestamp}';
        }
        if (type === 'append') {
            var appended = (source && /^https?:\/\//i.test(source) ? '' : url) + (source || '');
            return appended.indexOf('${') >= 0 ? appended : appended + (appended.indexOf('?') >= 0 ? '&' : '?') + 'utc=${start}&lutc=${timestamp}';
        }
        if (type === 'shift' || type === 'timeshift') {
            var shifted = source || url;
            return shifted + (shifted.indexOf('?') >= 0 ? '&' : '?') + 'utc=${start}&lutc=${timestamp}';
        }
        if (type === 'flussonic' || type === 'flussonic-hls' || type === 'flussonic-ts' || type === 'fs') {
            return url
                .replace(/\/(video\d*|mono\d*)\.(m3u8|ts)(\?|$)/, '/$1-${start}-${durationfs}.$2$3')
                .replace(/\/(index|playlist)\.(m3u8|ts)(\?|$)/, '/archive-${start}-${durationfs}.$2$3')
                .replace(/\/mpegts(\?|$)/, '/timeshift_abs-${start}.ts$1')
                .replace(/\/live(\?|$)/, '/${start}.ts$1');
        }
        if (type === 'xc' || type === 'xtream') {
            return url
                .replace(/^(https?:\/\/[^/]+)(\/live)?(\/[^/]+\/[^/]+\/)([^/.]+)\.m3u8?$/, '$1/timeshift$3${(d)M}/${(b)yyyy-MM-dd:HH-mm}/$4.m3u8')
                .replace(/^(https?:\/\/[^/]+)(\/live)?(\/[^/]+\/[^/]+\/)([^/.]+)(\.ts|)$/, '$1/timeshift$3${(d)M}/${(b)yyyy-MM-dd:HH-mm}/$4.ts');
        }
        return false;
    }

    function buildArchiveUrl(channel, program) {
        var template = catchupTemplate(channel);
        if (!template || !program) return false;

        var start = Math.floor(program.start / 1000);
        var end = Math.floor(program.stop / 1000);
        var now = Math.floor(Date.now() / 1000);
        var duration = Math.max(1, end - start);
        var values = {
            start: start,
            utc: start,
            end: end,
            utcend: end,
            timestamp: now,
            lutc: now,
            now: now,
            offset: Math.max(0, now - start),
            duration: duration,
            durationfs: end > now ? 'now' : duration
        };

        return template.replace(/\$\{([^}]+)\}/g, function (full, expression) {
            var dateMatch = /^\(([ben])(u)?\)(.+)$/.exec(expression);
            if (dateMatch) {
                var stamp = dateMatch[1] === 'b' ? start : dateMatch[1] === 'e' ? end : now;
                return encodeURIComponent(formatDate(stamp, dateMatch[3], Boolean(dateMatch[2])));
            }
            if (expression === '(d)M') return Math.max(1, Math.ceil(duration / 60));
            if (Object.prototype.hasOwnProperty.call(values, expression)) return encodeURIComponent(values[expression]);
            return full;
        });
    }

    function canArchive(channel, program) {
        if (!program || !channel.catchup.days || !catchupTemplate(channel)) return false;
        var oldest = Date.now() - (channel.catchup.days * 86400000);
        return program.start >= oldest && program.start <= Date.now();
    }

    function formatTime(timestamp) {
        var date = new Date(timestamp);
        return pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function dayKey(timestamp) {
        var date = new Date(timestamp);
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    function dayLabel(key) {
        var parts = text(key).split('-');
        var date = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        var today = dayKey(Date.now());
        var yesterday = dayKey(Date.now() - 86400000);
        var tomorrow = dayKey(Date.now() + 86400000);
        if (key === today) return 'Сегодня';
        if (key === yesterday) return 'Вчера';
        if (key === tomorrow) return 'Завтра';
        return ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'][date.getDay()] + ', ' + pad(date.getDate()) + '.' + pad(date.getMonth() + 1);
    }

    function qualityLabel(channel) {
        var match = /(?:^|[^a-zа-я0-9])(4k|uhd|fhd|hd)(?:$|[^a-zа-я0-9])/i.exec(channel.name);
        return match ? match[1].toUpperCase() : '';
    }

    function playArchive(channel, program, archiveList) {
        var url = buildArchiveUrl(channel, program);
        if (!url) return notify('Для этого канала не описан адрес архива');

        addToHistory(channel);

        function convert(item) {
            return {
                title: formatTime(item.start) + ' — ' + item.title,
                url: buildArchiveUrl(channel, item),
                need_check_live_stream: true,
                error: function () {
                    notify('Архив не открылся. Попробуйте другую передачу или CDN провайдера');
                }
            };
        }

        Lampa.Player.runas(Lampa.Storage.field('player_iptv'));
        Lampa.Player.play(convert(program));
        Lampa.Player.playlist((archiveList || []).filter(function (item) { return canArchive(channel, item); }).map(convert));
    }

    function recentPrograms(channel) {
        var now = Date.now();
        return programs(channel).filter(function (program) {
            return program.start <= now + 21600000 && program.stop >= now - ((channel.catchup.days || 1) * 86400000);
        });
    }

    function showPrograms(channel, returnController) {
        var list = recentPrograms(channel).reverse();

        if (!list.length) return notify('Для канала нет телепрограммы');

        var enabled = returnController || Lampa.Controller.enabled().name;
        Lampa.Select.show({
            title: channel.name + ' — архив',
            items: list.map(function (program) {
                var available = canArchive(channel, program);
                return {
                    title: formatTime(program.start) + '–' + formatTime(program.stop) + '  ' + program.title,
                    subtitle: program.desc || (available ? 'Доступно в архиве' : 'Только программа'),
                    program: program,
                    available: available
                };
            }),
            onSelect: function (item) {
                if (!item.available) return notify('Эта передача недоступна в архиве');
                Lampa.Select.hide();
                playArchive(channel, item.program, list.slice().reverse());
            },
            onBack: function () {
                Lampa.Controller.toggle(enabled);
            }
        });
    }

    function showChannelSelect(channel, index) {
        restoreArchiveGuide(channel);
        var enabled = Lampa.Controller.enabled().name;
        var now = Date.now();
        var guide = recentPrograms(channel);
        var current = currentProgramIndex(channel);
        var archiveKey = guideCacheKey(channel);
        var needsHistory = state.autoEpg && channel.catchup.days > 0 && state.guideMode !== 'full' && !state.archiveReady[archiveKey];
        var items = [
            {
                title: '▶ Прямой эфир',
                subtitle: current >= 0 && programs(channel)[current] ? programs(channel)[current].title : 'Смотреть канал сейчас',
                thumbnail: channel.logo,
                action: 'live'
            },
            {
                title: '♥ Favorites',
                subtitle: isFavorite(channel) ? 'Канал добавлен в избранное' : 'Добавить канал в избранное',
                checkbox: true,
                checked: isFavorite(channel),
                action: 'favorite'
            }
        ];

        if (guide.length) {
            items.push({ title: 'Программа передач и архив', separator: true });

            var ordered = guide.filter(function (program) {
                return program.start <= now && program.stop > now;
            }).concat(guide.filter(function (program) {
                return program.stop <= now;
            }).reverse()).concat(guide.filter(function (program) {
                return program.start > now;
            }));

            ordered.forEach(function (program) {
                var available = canArchive(channel, program);
                var isNow = program.start <= now && program.stop > now;
                items.push({
                    title: (available ? '↶ ' : isNow ? '● ' : '') + formatTime(program.start) + '–' + formatTime(program.stop) + '  ' + program.title,
                    subtitle: isNow ? (available ? 'Сейчас · можно смотреть с начала' : 'Сейчас в эфире') : available ? 'Доступно в архиве' : program.start > now ? 'Далее' : 'Архив недоступен',
                    program: program,
                    available: available,
                    noenter: !available,
                    action: 'program'
                });
            });
        } else {
            items.push({
                title: state.guideLoading ? 'Телепрограмма загружается…' : 'Телепрограмма не найдена',
                subtitle: state.guideLoading ? 'Прямой эфир уже можно запускать' : 'Проверьте адрес XMLTV',
                noenter: true
            });
        }

        if (needsHistory) {
            items.push({
                title: state.archiveLoading[archiveKey] ? 'Архив прошлых дней загружается…' : 'Подготовка архива прошлых дней…',
                subtitle: 'Меню обновится автоматически; прямой эфир доступен сразу',
                noenter: true
            });
        }

        state.selectedChannel = archiveKey;
        Lampa.Select.show({
            title: channel.name,
            items: items,
            nohide: true,
            onCheck: function (item) {
                if (item.action === 'favorite') {
                    setFavorite(channel, item.checked);
                    item.subtitle = item.checked ? 'Канал добавлен в избранное' : 'Добавить канал в избранное';
                    notify(item.checked ? 'Канал добавлен в Favorites' : 'Канал удалён из Favorites');
                }
            },
            onSelect: function (item) {
                if (item.action === 'live') {
                    state.selectedChannel = '';
                    Lampa.Select.hide();
                    playLive(index);
                } else if (item.action === 'program' && item.available) {
                    state.selectedChannel = '';
                    Lampa.Select.hide();
                    playArchive(channel, item.program, guide);
                }
            },
            onBack: function () {
                state.selectedChannel = '';
                Lampa.Controller.toggle(enabled);
            }
        });

        if (needsHistory && !state.archiveLoading[archiveKey]) {
            loadArchiveGuide(channel).then(function () {
                if (state.selectedChannel === archiveKey) {
                    Lampa.Select.hide();
                    showChannel(channel, index);
                    notify('Архив канала загружен');
                }
            }).catch(function () {
                if (state.selectedChannel === archiveKey) notify('Не удалось загрузить архивную программу за 60 секунд');
            });
        }
    }

    function showChannel(channel, index) {
        if (state.component && state.component.openChannel) {
            state.component.openChannel(channel, index);
            return;
        }
        showChannelSelect(channel, index);
    }

    function playerIcons(channel) {
        var current = programs(channel)[currentProgramIndex(channel)];
        var icons = [isFavorite(channel) ? '♥' : '♡'];
        if (canArchive(channel, current)) icons.push('↶');
        return icons;
    }

    function refreshPlayerIcons(channel) {
        var name = $('.player-panel-iptv-item.active .player-panel-iptv-item__name');
        name.find('.player-panel-iptv-item__icons-item').remove();
        playerIcons(channel).forEach(function (icon) {
            name.append('<div class="player-panel-iptv-item__icons-item">' + icon + '</div>');
        });
    }

    function showPlayerMenu(playerChannelObject) {
        var channel = playerChannelObject.original;
        var enabled = Lampa.Controller.enabled().name;
        Lampa.Select.show({
            title: channel.name,
            nohide: true,
            items: [
                {
                    title: '♥ Favorites',
                    subtitle: isFavorite(channel) ? 'Канал добавлен в избранное' : 'Добавить канал в избранное',
                    checkbox: true,
                    checked: isFavorite(channel),
                    action: 'favorite'
                },
                { title: 'Программа передач и архив', action: 'program' }
            ],
            onCheck: function (item) {
                if (item.action === 'favorite') {
                    setFavorite(channel, item.checked);
                    playerChannelObject.icons = playerIcons(channel);
                    refreshPlayerIcons(channel);
                    notify(item.checked ? 'Канал добавлен в Favorites' : 'Канал удалён из Favorites');
                }
            },
            onSelect: function (item) {
                if (item.action === 'program') {
                    Lampa.Select.hide();
                    showPrograms(channel, enabled);
                }
            },
            onBack: function () { Lampa.Controller.toggle(enabled); }
        });
    }

    function playerChannel(channel) {
        return {
            name: channel.name,
            group: channel.group,
            logo: channel.logo,
            url: channel.url,
            original: channel,
            icons: playerIcons(channel)
        };
    }

    function playLive(index) {
        var channels = state.visible;
        if (!channels.length) return;

        addToHistory(channels[index]);

        function getChannel(position) {
            var original = channels[position];
            var channel = playerChannel(original);
            var list = programs(original);
            var current = currentProgramIndex(original);

            setTimeout(function () {
                Lampa.Player.programReady({ channel: channel, position: Math.max(0, current), total: list.length });
            }, 20);
            return channel;
        }

        Lampa.Player.runas(Lampa.Storage.field('player_iptv'));
        Lampa.Player.iptv({
            title: channels[index].name,
            url: channels[index].url,
            position: index,
            total: channels.length,
            onGetChannel: getChannel,
            onGetProgram: function (channel, position, container) {
                var original = channel.original;
                var list = programs(original);
                var current = currentProgramIndex(original);
                var start = Math.max(0, Math.min(position, list.length - 1));
                var target = container && container[0] ? container[0] : container;
                var html = '';

                list.slice(start, start + 2).forEach(function (program, offset) {
                    html += '<div class="player-panel-iptv-item__prog-item' + (start + offset === current ? ' watch' : '') + '"><span>' +
                        escapeHtml(formatTime(program.start) + '–' + formatTime(program.stop) + '  ' + program.title) + '</span></div>';
                });
                $(target).html(html || '<div class="player-panel-iptv-item__prog-load">Нет программы</div>');
            },
            onPlaylistProgram: function (channel) {
                showPrograms(channel.original);
            },
            onMenu: function (channel) {
                showPlayerMenu(channel);
            }
        });
    }

    function loadData(force) {
        if (!force && state.channels.length && Date.now() - state.loadedAt < 600000) return Promise.resolve(state);

        var playlistUrl = field('playlist');
        if (!playlistUrl) return Promise.reject(new Error('Нажмите «Плейлист» и укажите URL M3U'));

        return requestText(playlistUrl).then(function (m3u) {
            var parsed = parseM3U(m3u);
            state.channels = parsed.channels;
            state.visible = parsed.channels.slice();
            state.groups = parsed.channels.map(function (channel) { return channel.group; }).filter(function (group, index, all) { return all.indexOf(group) === index; });
            state.playlistEpg = parsed.epgUrl;
            state.archiveHint = parsed.archiveHint;
            state.loadedAt = Date.now();
            state.epg = {};
            state.epgNames = {};
            state.guideMode = 'none';
            state.guideLoading = false;
            state.guidePromise = null;
            state.archiveLoading = {};
            state.archiveReady = {};
            state.guideTicket++;

            var guideUrl = field('epg') || parsed.epgUrl;
            var automatic = false;

            if (!guideUrl && parsed.archiveHint) {
                guideUrl = AUTO_EPG_LITE_URL;
                automatic = true;
            }

            state.autoEpg = automatic;
            if (guideUrl) {
                var scheduledTicket = state.guideTicket;
                setTimeout(function () {
                    if (scheduledTicket === state.guideTicket) startGuideLoad(guideUrl, automatic);
                }, 50);
            }
            return state;
        });
    }

    function editAddress(component, type) {
        var isPlaylist = type === 'playlist';
        Lampa.Input.edit({
            title: isPlaylist ? 'URL M3U-плейлиста' : 'URL телепрограммы XMLTV',
            value: field(type) || '',
            free: true,
            nosave: true,
            nomic: true
        }, function (value) {
            Lampa.Controller.toggle('content');

            value = text(value).trim();
            if (!value && isPlaylist) return;

            Lampa.Storage.set(PLUGIN + '_' + type, value);
            state.channels = [];
            state.visible = [];
            state.epg = {};
            state.epgNames = {};
            state.archiveHint = false;
            state.autoEpg = false;
            state.guideMode = 'none';
            state.guideLoading = false;
            state.guidePromise = null;
            state.archiveLoading = {};
            state.archiveReady = {};
            state.guideTicket++;
            state.loadedAt = 0;
            component.activity.loader(true);

            loadData(true).then(function () {
                component.renderLimit = CHANNEL_PAGE_SIZE;
                component.build();
                component.activity.loader(false);
                component.start();
                notify(isPlaylist ? 'Плейлист IPTV+ сохранён' : 'Телепрограмма IPTV+ сохранена');
            }).catch(function (error) {
                component.activity.loader(false);
                component.renderError(error);
                component.start();
                notify(error.message || (isPlaylist ? 'Не удалось загрузить плейлист' : 'Не удалось загрузить телепрограмму'));
            });
        });
    }

    function editPlaylist(component) {
        editAddress(component, 'playlist');
    }

    function editEpg(component) {
        editAddress(component, 'epg');
    }

    function Component(object) {
        var self = this;
        this.object = object || {};
        this.category = 'all';
        this.searchQuery = '';
        this.detailChannel = null;
        this.detailIndex = -1;
        this.detailDay = '';
        this.detailLast = null;
        this.historyDirty = false;
        this.html = $('<div class="iptv-plus-screen"><div class="iptv-plus-head"><div class="iptv-plus-title">IPTV+<span></span></div><div class="iptv-plus-clock"></div></div><div class="iptv-plus-toolbar"></div><div class="iptv-plus-layout"><div class="iptv-plus-sidebar"></div><div class="iptv-plus-list"></div></div><div class="iptv-plus-detail"></div></div>');
        this.last = null;
        this.clockTimer = 0;
        this.renderLimit = CHANNEL_PAGE_SIZE;

        this.updateClock = function () {
            var now = new Date();
            var days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
            self.html.find('.iptv-plus-clock').text(days[now.getDay()] + ', ' + pad(now.getDate()) + '.' + pad(now.getMonth() + 1) + '  ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
        };

        this.focused = function (element) {
            self.last = element;
            if (element && element.scrollIntoView) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        };

        this.create = function () {
            state.component = self;
            self.updateClock();
            clearInterval(self.clockTimer);
            self.clockTimer = setInterval(self.updateClock, 30000);
            self.activity.loader(true);
            loadData(false).then(function () {
                self.build();
                self.activity.loader(false);
                self.activity.toggle();
            }).catch(function (error) {
                self.activity.loader(false);
                self.renderError(error);
                self.activity.toggle();
            });
            return self.render();
        };

        this.buildToolbar = function () {
            var toolbar = self.html.find('.iptv-plus-toolbar').empty();
            var playlistButton = $('<div class="iptv-plus-button selector"><b>＋</b> Плейлист</div>');
            var epgButton = $('<div class="iptv-plus-button selector">' + (state.guideLoading ? 'EPG: загрузка…' : state.autoEpg ? 'EPG: AUTO' : 'EPG вручную') + '</div>');
            var searchButton = $('<div class="iptv-plus-button selector">⌕ Поиск' + (self.searchQuery ? ': ' + escapeHtml(self.searchQuery) : '') + '</div>');
            var reloadButton = $('<div class="iptv-plus-button selector">↻ Обновить</div>');

            playlistButton.on('hover:enter', function () { editPlaylist(self); });
            epgButton.on('hover:enter', function () { editEpg(self); });
            searchButton.on('hover:enter', function () {
                Lampa.Input.edit({
                    title: 'Поиск телеканала',
                    value: self.searchQuery,
                    free: true,
                    nosave: true,
                    nomic: true
                }, function (value) {
                    Lampa.Controller.toggle('content');
                    self.searchQuery = text(value).trim();
                    self.category = self.searchQuery ? 'search' : 'all';
                    self.renderLimit = CHANNEL_PAGE_SIZE;
                    self.build();
                    self.start();
                });
            });
            reloadButton.on('hover:enter', function () {
                self.activity.loader(true);
                loadData(true).then(function () {
                    self.renderLimit = CHANNEL_PAGE_SIZE;
                    self.build();
                    self.activity.loader(false);
                    self.start();
                    notify('IPTV+ обновлён');
                }).catch(function (error) {
                    self.activity.loader(false);
                    self.renderError(error);
                    notify(error.message || 'Ошибка обновления');
                });
            });
            toolbar.append(playlistButton, searchButton, epgButton, reloadButton);
            toolbar.find('.selector').on('hover:focus', function () { self.focused(this); });
        };

        this.buildCategories = function () {
            var sidebar = self.html.find('.iptv-plus-sidebar').empty();
            var favoritesCount = state.channels.filter(isFavorite).length;
            var categories = [
                { id: 'favorites', title: 'Favorites', icon: '♥', count: favoritesCount },
                { id: 'all', title: 'All', icon: '▦', count: state.channels.length },
                { id: 'recent', title: 'Недавние', icon: '◷', count: historyChannels().length }
            ];

            if (self.searchQuery) {
                categories.push({ id: 'search', title: 'Поиск', icon: '⌕', count: state.channels.filter(function (channel) {
                    var query = normalizeExact(self.searchQuery);
                    return normalizeExact(channel.name + ' ' + channel.group).indexOf(query) >= 0;
                }).length });
            }

            categories = categories.concat(state.groups.map(function (group) {
                return {
                    id: 'group:' + group,
                    title: group,
                    icon: text(group).slice(0, 1).toUpperCase(),
                    count: state.channels.filter(function (channel) { return channel.group === group; }).length
                };
            }));

            categories.forEach(function (item) {
                var button = $('<div class="iptv-plus-category selector' + (item.id === self.category ? ' active' : '') + '"><div class="iptv-plus-category-icon">' + escapeHtml(item.icon) + '</div><div class="iptv-plus-category-name">' + escapeHtml(item.title) + '</div><div class="iptv-plus-category-count">' + item.count + '</div></div>');
                button.on('hover:focus', function () { self.focused(this); });
                button.on('hover:enter', function () {
                    self.category = item.id;
                    if (item.id !== 'search') self.searchQuery = '';
                    self.renderLimit = CHANNEL_PAGE_SIZE;
                    self.build();
                    self.last = self.html.find('.iptv-plus-category.active')[0];
                    self.start();
                });
                sidebar.append(button);
            });
        };

        this.renderError = function (error) {
            self.buildToolbar();
            self.html.find('.iptv-plus-title span').text(' / настройка');
            self.html.find('.iptv-plus-sidebar').empty();
            var list = self.html.find('.iptv-plus-list').empty();
            var empty = $('<div class="iptv-plus-empty"><div class="iptv-plus-empty-icon">TV</div><div class="iptv-plus-empty-copy"><div class="iptv-plus-empty-title">Добавьте IPTV-плейлист</div><div class="iptv-plus-empty-text">' + escapeHtml(error && (error.message || error) || 'Укажите прямую ссылку на M3U/M3U8') + '</div><div class="iptv-plus-empty-hint">После загрузки здесь появятся каналы, программа передач и архив.</div></div><div class="iptv-plus-empty-action selector">＋ Добавить M3U</div></div>');
            empty.find('.iptv-plus-empty-action').on('hover:focus', function () { self.focused(this); });
            empty.find('.iptv-plus-empty-action').on('hover:enter', function () { editPlaylist(self); });
            list.append(empty);
        };

        this.build = function (preserveCategoryFocus) {
            self.last = null;
            self.buildToolbar();
            self.buildCategories();
            var listContainer = self.html.find('.iptv-plus-list').empty();

            if (self.category === 'favorites') state.visible = state.channels.filter(isFavorite);
            else if (self.category === 'recent') state.visible = historyChannels();
            else if (self.category === 'search') {
                var query = normalizeExact(self.searchQuery);
                state.visible = state.channels.filter(function (channel) {
                    return normalizeExact(channel.name + ' ' + channel.group).indexOf(query) >= 0;
                });
            }
            else if (self.category.indexOf('group:') === 0) {
                var selectedGroup = self.category.slice(6);
                state.visible = state.channels.filter(function (channel) { return channel.group === selectedGroup; });
            } else state.visible = state.channels.slice();

            var categoryTitle = self.category === 'favorites' ? 'Favorites' : self.category === 'recent' ? 'Недавние' : self.category === 'search' ? 'Поиск: ' + self.searchQuery : self.category === 'all' ? 'All' : self.category.slice(6);
            self.html.find('.iptv-plus-title span').text(' / ' + categoryTitle + ' · ' + state.visible.length);

            var displayed = state.visible.slice(0, self.renderLimit);

            displayed.forEach(function (channel, index) {
                var channelPrograms = programs(channel);
                var currentPosition = currentProgramIndex(channel);
                var current = currentPosition >= 0 ? channelPrograms[currentPosition] : null;
                var progress = programProgress(current);
                var time = current ? formatTime(current.start) + '–' + formatTime(current.stop) : 'Программа не найдена';
                var quality = qualityLabel(channel);
                var row = $('<div class="iptv-plus-channel selector"><div class="iptv-plus-number">' + pad((channel.index || 0) + 1) + '</div><div class="iptv-plus-logo"></div><div class="iptv-plus-channel-body"><div class="iptv-plus-name">' + escapeHtml(channel.name) + (quality ? ' <span class="iptv-plus-quality">' + quality + '</span>' : '') + '</div><div class="iptv-plus-now">' + escapeHtml(current ? current.title : channel.group) + '</div><div class="iptv-plus-time">' + escapeHtml(time) + '</div><div class="iptv-plus-progress"><i style="width:' + progress + '%"></i></div></div><div class="iptv-plus-channel-flags">' + (isFavorite(channel) ? '<div class="iptv-plus-heart">♥</div>' : '') + (canArchive(channel, current) ? '<div class="iptv-plus-archive">↶ Архив</div>' : '') + '<div class="iptv-plus-chevron">›</div></div></div>');
                row.data('channel-key', channelKey(channel));
                var logo = row.find('.iptv-plus-logo');

                if (channel.logo) logo.append('<img loading="lazy" src="' + escapeHtml(channel.logo) + '">');
                else logo.text(channel.name.slice(0, 2).toUpperCase());

                row.on('hover:focus', function () { self.focused(this); });
                row.on('hover:enter', function () { showChannel(channel, index); });
                listContainer.append(row);
            });

            if (displayed.length < state.visible.length) {
                var remaining = state.visible.length - displayed.length;
                var more = $('<div class="iptv-plus-more selector"><b>Показать ещё</b><span>' + remaining + ' каналов</span></div>');
                more.on('hover:focus', function () { self.focused(this); });
                more.on('hover:enter', function () {
                    var firstNew = displayed.length;
                    self.renderLimit += CHANNEL_PAGE_SIZE;
                    self.build();
                    self.last = self.html.find('.iptv-plus-channel').eq(firstNew)[0];
                    self.start();
                });
                listContainer.append(more);
            }

            if (!state.visible.length) {
                var emptyTitle = self.category === 'favorites' ? 'Favorites пока пуст' : self.category === 'recent' ? 'История просмотра пуста' : self.category === 'search' ? 'Каналы не найдены' : 'В этой категории нет каналов';
                var emptyText = self.category === 'favorites' ? 'Откройте канал и нажмите ♥ Favorites.' : self.category === 'recent' ? 'Запущенные каналы появятся здесь автоматически.' : self.category === 'search' ? 'Измените поисковый запрос.' : 'Выберите другую категорию слева.';
                listContainer.html('<div class="iptv-plus-error"><b>' + emptyTitle + '</b><span>' + emptyText + '</span></div>');
            }

            if (!self.last) {
                var lastChannelKey = storage('last_channel', '');
                self.html.find('.iptv-plus-channel').each(function () {
                    if (!self.last && $(this).data('channel-key') === lastChannelKey) self.last = this;
                });
            }

            if (preserveCategoryFocus) self.last = self.html.find('.iptv-plus-category.active')[0];
        };

        this.onFavoritesChanged = function () {
            if (self.detailChannel) self.renderChannel(true);
            else self.build(true);
        };

        this.refreshOpenChannel = function () {
            if (!self.detailChannel) return false;
            self.renderChannel(true);
            return true;
        };

        this.closeChannel = function () {
            self.detailChannel = null;
            self.detailIndex = -1;
            self.detailDay = '';
            self.detailLast = null;
            state.selectedChannel = '';
            state.selectedDay = '';
            self.html.find('.iptv-plus-detail').removeClass('open').empty();
            self.build();
            self.start();
        };

        this.startDetail = function () {
            var panel = self.html.find('.iptv-plus-detail');
            Lampa.Controller.add('content', {
                link: self,
                toggle: function () {
                    Lampa.Controller.collectionSet(panel);
                    Lampa.Controller.collectionFocus(self.detailLast || false, panel);
                },
                left: function () { if (Navigator.canmove('left')) Navigator.move('left'); },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                up: function () { if (Navigator.canmove('up')) Navigator.move('up'); },
                down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
                back: function () { self.closeChannel(); }
            });
            Lampa.Controller.toggle('content');
        };

        this.renderChannel = function (preserveFocus) {
            var channel = self.detailChannel;
            if (!channel) return;

            var panel = self.html.find('.iptv-plus-detail').empty().addClass('open');
            var now = Date.now();
            var allPrograms = programs(channel).filter(function (program) {
                return program.stop >= now - ((channel.catchup.days || 1) * 86400000) && program.start <= now + (2 * 86400000);
            });
            var current = allPrograms.filter(function (program) { return program.start <= now && program.stop > now; })[0];
            var days = [];
            allPrograms.forEach(function (program) {
                var key = dayKey(program.start);
                if (days.indexOf(key) < 0) days.push(key);
            });
            days.sort();
            if (!self.detailDay || days.indexOf(self.detailDay) < 0) {
                self.detailDay = days.indexOf(dayKey(now)) >= 0 ? dayKey(now) : (days[days.length - 1] || dayKey(now));
            }
            state.selectedDay = self.detailDay;

            var header = $('<div class="iptv-plus-detail-head"><div class="iptv-plus-detail-logo"></div><div class="iptv-plus-detail-copy"><div class="iptv-plus-detail-name">' + escapeHtml(channel.name) + '</div><div class="iptv-plus-detail-meta"><span>' + escapeHtml(channel.group) + '</span>' + (qualityLabel(channel) ? '<b>' + qualityLabel(channel) + '</b>' : '') + (channel.catchup.days ? '<b class="archive">↶ ' + channel.catchup.days + ' дн.</b>' : '') + '</div><div class="iptv-plus-detail-now">' + escapeHtml(current ? 'Сейчас: ' + current.title : 'Прямой эфир доступен') + '</div></div><div class="iptv-plus-detail-clock">' + escapeHtml(dayLabel(dayKey(now))) + '<b>' + formatTime(now) + '</b></div></div>');
            var headerLogo = header.find('.iptv-plus-detail-logo');
            if (channel.logo) headerLogo.append('<img src="' + escapeHtml(channel.logo) + '">');
            else headerLogo.text(channel.name.slice(0, 2).toUpperCase());

            var actions = $('<div class="iptv-plus-detail-actions"></div>');
            var back = $('<div class="iptv-plus-action selector" data-detail-action="back">← Каналы</div>');
            var live = $('<div class="iptv-plus-action primary selector" data-detail-action="live">▶ Прямой эфир</div>');
            var favorite = $('<div class="iptv-plus-action selector" data-detail-action="favorite">' + (isFavorite(channel) ? '♥ В Favorites' : '♡ В Favorites') + '</div>');
            actions.append(back, live, favorite);
            if (canArchive(channel, current)) actions.append('<div class="iptv-plus-action selector" data-detail-action="restart">↶ С начала</div>');

            var body = $('<div class="iptv-plus-detail-body"><div class="iptv-plus-days"></div><div class="iptv-plus-schedule"></div></div>');
            var dayBar = body.find('.iptv-plus-days');
            var schedule = body.find('.iptv-plus-schedule');

            days.forEach(function (key) {
                var day = $('<div class="iptv-plus-day selector' + (key === self.detailDay ? ' active' : '') + '" data-day="' + escapeHtml(key) + '"><b>' + escapeHtml(dayLabel(key)) + '</b><span>' + allPrograms.filter(function (program) { return dayKey(program.start) === key; }).length + ' передач</span></div>');
                dayBar.append(day);
            });

            var selectedPrograms = allPrograms.filter(function (program) { return dayKey(program.start) === self.detailDay; });
            selectedPrograms.forEach(function (program) {
                var available = canArchive(channel, program);
                var isNow = program.start <= now && program.stop > now;
                var isFuture = program.start > now;
                var status = available ? (isNow ? 'Смотреть с начала' : 'Доступно в архиве') : isNow ? 'Сейчас в эфире' : isFuture ? 'Далее' : 'Архив недоступен';
                var selectable = available || isNow;
                var progress = isNow ? programProgress(program, now) : 0;
                var item = $('<div class="iptv-plus-program' + (selectable ? ' selector' : ' disabled') + (isNow ? ' now' : '') + (available ? ' archived' : '') + '"><div class="iptv-plus-program-time">' + formatTime(program.start) + '<span>' + formatTime(program.stop) + '</span></div><div class="iptv-plus-program-copy"><div class="iptv-plus-program-title">' + escapeHtml(program.title) + '</div><div class="iptv-plus-program-desc">' + escapeHtml(program.desc || status) + '</div>' + (isNow ? '<div class="iptv-plus-program-progress"><i style="width:' + progress + '%"></i></div>' : '') + '</div><div class="iptv-plus-program-status">' + (available ? '↶ ' : isNow ? '● ' : '') + escapeHtml(status) + '</div></div>');
                if (selectable) {
                    item.on('hover:enter', function () {
                        var index = self.detailIndex >= 0 ? self.detailIndex : state.visible.indexOf(channel);
                        self.closeChannel();
                        if (available) playArchive(channel, program, allPrograms);
                        else playLive(index);
                    });
                }
                schedule.append(item);
            });

            var archiveKey = guideCacheKey(channel);
            var needsHistory = state.autoEpg && channel.catchup.days > 0 && state.guideMode !== 'full' && !state.archiveReady[archiveKey];
            if (!selectedPrograms.length) {
                schedule.append('<div class="iptv-plus-schedule-empty"><b>' + (state.guideLoading || state.archiveLoading[archiveKey] ? 'Программа загружается…' : 'Нет программы на выбранный день') + '</b><span>Прямой эфир можно запустить сразу.</span></div>');
            }
            if (needsHistory) {
                schedule.prepend('<div class="iptv-plus-schedule-loading"><i></i><span>' + (state.archiveLoading[archiveKey] ? 'Загружаю архив прошлых дней…' : 'Подготавливаю архив…') + '</span></div>');
            }

            panel.append(header, actions, body);
            panel.find('.selector').on('hover:focus', function () {
                self.detailLast = this;
                if (this.scrollIntoView) this.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });
            back.on('hover:enter', self.closeChannel);
            live.on('hover:enter', function () {
                var index = self.detailIndex;
                self.closeChannel();
                playLive(index);
            });
            favorite.on('hover:enter', function () { setFavorite(channel, !isFavorite(channel)); });
            actions.find('[data-detail-action="restart"]').on('hover:enter', function () {
                self.closeChannel();
                playArchive(channel, current, allPrograms);
            });
            dayBar.find('.iptv-plus-day').on('hover:enter', function () {
                self.detailDay = $(this).attr('data-day');
                self.detailLast = null;
                self.renderChannel(false);
                self.startDetail();
            });

            if (!preserveFocus || !self.detailLast || !panel[0].contains(self.detailLast)) self.detailLast = live[0];

            if (needsHistory && !state.archiveLoading[archiveKey]) {
                loadArchiveGuide(channel).then(function () {
                    if (self.detailChannel === channel) self.renderChannel(true);
                }).catch(function () {
                    if (self.detailChannel === channel) notify('Не удалось загрузить архивную программу');
                });
            }
        };

        this.openChannel = function (channel, index) {
            self.detailChannel = channel;
            self.detailIndex = index;
            self.detailDay = dayKey(Date.now());
            self.detailLast = null;
            state.selectedChannel = guideCacheKey(channel);
            restoreArchiveGuide(channel);
            self.renderChannel(false);
            self.startDetail();
        };

        this.start = function () {
            if (self.detailChannel) {
                self.startDetail();
                return;
            }
            if (self.historyDirty) {
                self.historyDirty = false;
                self.build();
            }
            Lampa.Controller.add('content', {
                link: self,
                toggle: function () {
                    Lampa.Controller.collectionSet(self.html);
                    Lampa.Controller.collectionFocus(self.last || false, self.html);
                },
                left: function () {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () { if (Navigator.canmove('right')) Navigator.move('right'); },
                up: function () {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { if (Navigator.canmove('down')) Navigator.move('down'); },
                back: function () { Lampa.Activity.backward(); }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.render = function () { return self.html; };
        this.destroy = function () {
            clearInterval(self.clockTimer);
            self.detailChannel = null;
            if (state.component === self) state.component = null;
            self.html.remove();
        };
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({ component: PLUGIN, icon: ICON, name: 'IPTV+' });

        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: PLUGIN + '_playlist', type: 'input', default: '' },
            field: { name: 'URL M3U-плейлиста', description: 'Прямая ссылка на M3U/M3U8' }
        });
        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: PLUGIN + '_epg', type: 'input', default: '' },
            field: { name: 'URL XMLTV', description: 'Необязательно: для плейлистов с tvg-rec программа подбирается автоматически' }
        });
        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { name: PLUGIN + '_archive_days', type: 'select', values: { 1: '1 день', 3: '3 дня', 7: '7 дней', 14: '14 дней' }, default: '3' },
            field: { name: 'Архив по умолчанию', description: 'Используется, если в плейлисте нет catchup-days' }
        });
        Lampa.SettingsApi.addParam({
            component: PLUGIN,
            param: { type: 'button' },
            field: { name: 'Очистить кеш IPTV+' },
            onChange: function () {
                state.channels = [];
                state.visible = [];
                state.epg = {};
                state.epgNames = {};
                state.archiveHint = false;
                state.autoEpg = false;
                state.guideMode = 'none';
                state.guideLoading = false;
                state.guidePromise = null;
                state.archiveLoading = {};
                state.archiveReady = {};
                state.selectedChannel = '';
                state.guideTicket++;
                state.loadedAt = 0;
                Lampa.Storage.set(PLUGIN + '_archive_cache', []);
                notify('Кеш IPTV+ очищен');
            }
        });
    }

    function addMenu() {
        if ($('.menu .menu__list .' + PLUGIN + '-menu').length) return;
        var button = $('<li class="menu__item selector ' + PLUGIN + '-menu"><div class="menu__ico">' + ICON + '</div><div class="menu__text">IPTV+</div></li>');
        button.on('hover:enter', function () {
            Lampa.Activity.push({ url: '', title: 'IPTV+', component: PLUGIN, page: 1 });
        });
        $('.menu .menu__list').eq(0).append(button);
    }

    function addStyles() {
        if ($('#iptv-plus-style').length) return;
        $('body').append('<style id="iptv-plus-style">' +
            '.iptv-plus-screen{position:relative;height:100%;min-height:100%;padding:1.15em 2.2em 1.5em;box-sizing:border-box;overflow:hidden;color:#fff}' +
            '.iptv-plus-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:.7em}' +
            '.iptv-plus-title{font-size:1.55em;font-weight:600;letter-spacing:.01em}.iptv-plus-title span{font-size:.72em;font-weight:400;opacity:.58}' +
            '.iptv-plus-clock{font-size:1em;opacity:.72}' +
            '.iptv-plus-toolbar{display:flex;gap:.6em;margin-bottom:.75em}' +
            '.iptv-plus-button{padding:.58em .9em;background:rgba(18,25,39,.72);border:1px solid rgba(255,255,255,.13);border-radius:.55em;font-size:.96em}' +
            '.iptv-plus-button.focus,.iptv-plus-empty-action.focus{background:#fff;color:#111;border-color:#fff;box-shadow:0 0 0 .18em rgba(255,255,255,.2)}' +
            '.iptv-plus-layout{display:grid;grid-template-columns:15.5em minmax(0,1fr);gap:.85em;height:calc(100% - 7.3em);min-height:24em}' +
            '.iptv-plus-sidebar,.iptv-plus-list{min-height:0;overflow-y:auto;scrollbar-width:none}.iptv-plus-sidebar::-webkit-scrollbar,.iptv-plus-list::-webkit-scrollbar{display:none}' +
            '.iptv-plus-sidebar{padding:.32em;border-radius:.75em;background:rgba(8,13,23,.66);border:1px solid rgba(255,255,255,.08)}' +
            '.iptv-plus-category{display:grid;grid-template-columns:2.25em minmax(0,1fr) auto;align-items:center;gap:.55em;min-height:3.25em;padding:.42em .65em;margin-bottom:.28em;border-radius:.56em;box-sizing:border-box;color:rgba(255,255,255,.72)}' +
            '.iptv-plus-category-icon{width:2em;height:2em;display:flex;align-items:center;justify-content:center;border-radius:.5em;background:rgba(255,255,255,.08);font-size:.92em;font-weight:700}.iptv-plus-category-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:570}.iptv-plus-category-count{font-size:.72em;opacity:.5}' +
            '.iptv-plus-category.active{color:#74e2a8;background:rgba(60,196,127,.1)}.iptv-plus-category.active .iptv-plus-category-icon{background:rgba(60,196,127,.18)}' +
            '.iptv-plus-category.focus{background:#fff;color:#10141d;box-shadow:0 .45em 1.5em rgba(0,0,0,.3)}.iptv-plus-category.focus .iptv-plus-category-icon{background:rgba(10,20,35,.08)}' +
            '.iptv-plus-list{padding:.05em .28em .8em}' +
            '.iptv-plus-channel{display:grid;grid-template-columns:2.7em 5.2em minmax(0,1fr) auto;align-items:center;gap:.85em;min-height:6.25em;padding:.55em .8em;margin-bottom:.52em;border-radius:.7em;background:linear-gradient(100deg,rgba(28,38,56,.92),rgba(12,18,30,.82));border:1px solid rgba(255,255,255,.09);box-sizing:border-box;transition:background .14s ease,transform .14s ease}' +
            '.iptv-plus-channel.focus{background:linear-gradient(100deg,#f7f8fb,#dfe4ec);color:#10141d;border-color:#fff;transform:scale(1.008);box-shadow:0 .5em 1.7em rgba(0,0,0,.34);z-index:2}' +
            '.iptv-plus-number{font-size:.82em;font-weight:700;letter-spacing:.08em;opacity:.46;text-align:center}' +
            '.iptv-plus-logo{width:5.2em;height:4.7em;border-radius:.58em;background:rgba(255,255,255,.075);display:flex;align-items:center;justify-content:center;font-size:1.25em;font-weight:750;overflow:hidden}' +
            '.iptv-plus-channel.focus .iptv-plus-logo{background:rgba(16,25,40,.07)}.iptv-plus-logo img{width:86%;height:86%;object-fit:contain}' +
            '.iptv-plus-channel-body{min-width:0}.iptv-plus-name{font-size:1.08em;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-plus-quality{display:inline-flex;vertical-align:.12em;padding:.13em .34em;margin-left:.28em;border-radius:.3em;background:#388dff;color:#fff;font-size:.56em;line-height:1.2;letter-spacing:.04em}' +
            '.iptv-plus-now{font-size:.84em;opacity:.72;margin-top:.28em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iptv-plus-time{font-size:.7em;opacity:.48;margin-top:.22em}' +
            '.iptv-plus-progress{height:.18em;margin-top:.42em;background:rgba(255,255,255,.16);border-radius:1em;overflow:hidden}.iptv-plus-channel.focus .iptv-plus-progress{background:rgba(10,20,35,.14)}.iptv-plus-progress i{display:block;height:100%;background:#51c98a;border-radius:1em}' +
            '.iptv-plus-channel-flags{display:flex;align-items:center;gap:.5em}.iptv-plus-heart{font-size:1.25em;color:#ef6c83}.iptv-plus-archive{padding:.28em .5em;border-radius:.4em;background:rgba(70,199,133,.16);color:#78e6aa;font-size:.72em;font-weight:650;white-space:nowrap}.iptv-plus-channel.focus .iptv-plus-archive{background:rgba(24,122,74,.12);color:#167448}.iptv-plus-chevron{font-size:1.8em;opacity:.35}' +
            '.iptv-plus-more{display:flex;align-items:center;justify-content:space-between;padding:1em 1.2em;margin:.7em 0;border-radius:.65em;background:rgba(28,38,56,.88);border:1px solid rgba(255,255,255,.1)}.iptv-plus-more span{font-size:.78em;opacity:.55}.iptv-plus-more.focus{background:#fff;color:#10141d}' +
            '.iptv-plus-empty{min-height:21em;display:flex;align-items:center;gap:1.3em;padding:2.2em;border-radius:.8em;background:linear-gradient(135deg,rgba(31,42,62,.9),rgba(12,18,30,.82));border:1px solid rgba(255,255,255,.1)}' +
            '.iptv-plus-empty-icon{width:3.1em;height:2.4em;display:flex;align-items:center;justify-content:center;border:.12em solid rgba(255,255,255,.7);border-radius:.42em;font-size:1.4em;font-weight:800}' +
            '.iptv-plus-empty-copy{flex:1}.iptv-plus-empty-title{font-size:1.42em;font-weight:650}.iptv-plus-empty-text{font-size:.98em;margin-top:.45em;opacity:.75}.iptv-plus-empty-hint{font-size:.8em;margin-top:.4em;opacity:.42}' +
            '.iptv-plus-empty-action{padding:.72em 1em;border-radius:.55em;background:#4cc986;color:#0d2218;font-weight:700}' +
            '.iptv-plus-error{display:flex;flex-direction:column;gap:.35em;font-size:1.05em;line-height:1.5;padding:2em;opacity:.75}.iptv-plus-error span{font-size:.82em;opacity:.65}' +
            '.iptv-plus-detail{display:none;position:absolute;inset:0;z-index:20;padding:1.25em 2.2em 1.6em;box-sizing:border-box;background:linear-gradient(120deg,rgba(7,12,21,.985),rgba(16,25,40,.985));overflow:hidden}.iptv-plus-detail.open{display:flex;flex-direction:column}' +
            '.iptv-plus-detail-head{display:grid;grid-template-columns:7.2em minmax(0,1fr) auto;align-items:center;gap:1.2em;min-height:7em}.iptv-plus-detail-logo{width:7.2em;height:6.2em;border-radius:.8em;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;font-size:1.5em;font-weight:800;overflow:hidden}.iptv-plus-detail-logo img{width:86%;height:86%;object-fit:contain}' +
            '.iptv-plus-detail-copy{min-width:0}.iptv-plus-detail-name{font-size:1.7em;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iptv-plus-detail-meta{display:flex;gap:.55em;align-items:center;margin-top:.45em;color:rgba(255,255,255,.6)}.iptv-plus-detail-meta b{padding:.2em .45em;border-radius:.35em;background:rgba(56,141,255,.22);color:#85b9ff;font-size:.75em}.iptv-plus-detail-meta b.archive{background:rgba(70,199,133,.17);color:#78e6aa}.iptv-plus-detail-now{margin-top:.55em;font-size:.92em;color:rgba(255,255,255,.72)}' +
            '.iptv-plus-detail-clock{text-align:right;font-size:.78em;opacity:.62}.iptv-plus-detail-clock b{display:block;font-size:1.7em;margin-top:.15em;color:#fff}' +
            '.iptv-plus-detail-actions{display:flex;gap:.65em;margin:.75em 0 1em}.iptv-plus-action{padding:.68em 1em;border-radius:.55em;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);font-weight:650}.iptv-plus-action.primary{background:#49ca87;color:#092116;border-color:#49ca87}.iptv-plus-action.focus{background:#fff;color:#111;border-color:#fff;box-shadow:0 0 0 .18em rgba(255,255,255,.18)}' +
            '.iptv-plus-detail-body{display:grid;grid-template-columns:13.8em minmax(0,1fr);gap:.9em;min-height:0;flex:1}.iptv-plus-days,.iptv-plus-schedule{min-height:0;overflow-y:auto;scrollbar-width:none}.iptv-plus-days::-webkit-scrollbar,.iptv-plus-schedule::-webkit-scrollbar{display:none}.iptv-plus-days{padding:.3em;border-radius:.72em;background:rgba(3,8,15,.48);border:1px solid rgba(255,255,255,.07)}' +
            '.iptv-plus-day{padding:.7em .75em;margin-bottom:.28em;border-radius:.52em;color:rgba(255,255,255,.67)}.iptv-plus-day b,.iptv-plus-day span{display:block}.iptv-plus-day span{margin-top:.18em;font-size:.68em;opacity:.55}.iptv-plus-day.active{background:rgba(70,199,133,.12);color:#7ce5ad}.iptv-plus-day.focus{background:#fff;color:#111}' +
            '.iptv-plus-schedule{padding:.05em .25em .8em}.iptv-plus-program{display:grid;grid-template-columns:4.5em minmax(0,1fr) auto;align-items:center;gap:.85em;min-height:4.7em;padding:.55em .8em;margin-bottom:.42em;border-radius:.65em;background:rgba(28,38,56,.78);border:1px solid rgba(255,255,255,.075)}.iptv-plus-program.now{border-left:.22em solid #4dce8b}.iptv-plus-program.disabled{opacity:.52}.iptv-plus-program.focus{background:#fff;color:#111;transform:scale(1.004)}' +
            '.iptv-plus-program-time{font-size:1em;font-weight:700}.iptv-plus-program-time span{display:block;margin-top:.18em;font-size:.72em;font-weight:400;opacity:.55}.iptv-plus-program-copy{min-width:0}.iptv-plus-program-title{font-size:1.02em;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iptv-plus-program-desc{font-size:.72em;margin-top:.26em;opacity:.56;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.iptv-plus-program-status{font-size:.7em;color:#76dfa5;white-space:nowrap}.iptv-plus-program.focus .iptv-plus-program-status{color:#167448}' +
            '.iptv-plus-program-progress{height:.18em;margin-top:.42em;background:rgba(255,255,255,.15);border-radius:1em;overflow:hidden}.iptv-plus-program-progress i{display:block;height:100%;background:#4dce8b}.iptv-plus-program.focus .iptv-plus-program-progress{background:rgba(0,0,0,.13)}' +
            '.iptv-plus-schedule-loading,.iptv-plus-schedule-empty{display:flex;align-items:center;gap:.65em;padding:.85em 1em;margin-bottom:.5em;border-radius:.6em;background:rgba(70,199,133,.1);color:#83e7af}.iptv-plus-schedule-loading i{width:.65em;height:.65em;border:.12em solid currentColor;border-top-color:transparent;border-radius:50%;animation:iptv-plus-spin .8s linear infinite}.iptv-plus-schedule-empty{align-items:flex-start;flex-direction:column;color:rgba(255,255,255,.7)}.iptv-plus-schedule-empty span{font-size:.76em;opacity:.6}@keyframes iptv-plus-spin{to{transform:rotate(360deg)}}' +
            '@media(max-width:1050px){.iptv-plus-layout{grid-template-columns:12.5em minmax(0,1fr)}.iptv-plus-channel{grid-template-columns:2.2em 4.5em minmax(0,1fr) auto}.iptv-plus-logo{width:4.5em;height:4.1em}.iptv-plus-archive{display:none}}' +
            '@media(max-width:760px){.iptv-plus-screen{padding:1em}.iptv-plus-layout{grid-template-columns:9.3em minmax(0,1fr);height:calc(100% - 6.8em)}.iptv-plus-clock{display:none}.iptv-plus-category{grid-template-columns:2em minmax(0,1fr)}.iptv-plus-category-count,.iptv-plus-number{display:none}.iptv-plus-channel{grid-template-columns:3.8em minmax(0,1fr) auto;gap:.55em}.iptv-plus-logo{width:3.8em;height:3.5em}.iptv-plus-empty{align-items:flex-start;flex-direction:column}.iptv-plus-detail{padding:1em}.iptv-plus-detail-head{grid-template-columns:5em minmax(0,1fr)}.iptv-plus-detail-logo{width:5em;height:4.5em}.iptv-plus-detail-clock{display:none}.iptv-plus-detail-body{grid-template-columns:9em minmax(0,1fr)}.iptv-plus-program{grid-template-columns:3.5em minmax(0,1fr)}.iptv-plus-program-status{display:none}}' +
            '</style>');
    }

    function startPlugin() {
        Lampa.Component.add(PLUGIN, Component);
        addSettings();
        addStyles();
        addMenu();
        console.log('IPTV+', 'plugin ready', VERSION);
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') startPlugin();
    });
})();
