(function () {
    'use strict';

    if (window.lampa_iptv_plus_ready) return;
    window.lampa_iptv_plus_ready = true;

    var PLUGIN = 'iptv_plus';
    var VERSION = '0.1.0';
    var network = new Lampa.Reguest();
    var state = {
        channels: [],
        visible: [],
        groups: [],
        epg: {},
        epgNames: {},
        playlistEpg: '',
        loadedAt: 0
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

    function normalize(value) {
        return text(value)
            .toLowerCase()
            .replace(/[ё]/g, 'е')
            .replace(/\b(hd|fhd|uhd|4k|sd)\b/gi, '')
            .replace(/[^a-zа-я0-9]+/gi, ' ')
            .trim();
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
            days: attr(header, 'catchup-days') || attr(header, 'tvg-rec') || attr(header, 'timeshift')
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
                var days = attr(line, 'catchup-days') || attr(line, 'tvg-rec') || attr(line, 'timeshift') || headerCatchup.days;
                var type = attr(line, 'catchup') || headerCatchup.type;
                var sourceValue = attr(line, 'catchup-source') || headerCatchup.source;

                if (!type && sourceValue) type = /^https?:\/\//i.test(sourceValue) ? 'default' : 'append';

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

        return { channels: channels, epgUrl: epgUrl };
    }

    function parseXmltvDate(value) {
        var match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])(\d{2})(\d{2})/.exec(text(value));
        if (!match) return 0;

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
            var display = childText(channelNodes[i], 'display-name');
            if (id && display) epgNames[normalize(display)] = id;
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

    function epgId(channel) {
        if (channel.id && state.epg[channel.id]) return channel.id;
        if (channel.tvgName && state.epgNames[normalize(channel.tvgName)]) return state.epgNames[normalize(channel.tvgName)];
        if (state.epgNames[normalize(channel.name)]) return state.epgNames[normalize(channel.name)];
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
        return 0;
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

    function playArchive(channel, program, archiveList) {
        var url = buildArchiveUrl(channel, program);
        if (!url) return notify('Для этого канала не описан адрес архива');

        function convert(item) {
            return {
                title: formatTime(item.start) + ' — ' + item.title,
                url: buildArchiveUrl(channel, item),
                need_check_live_stream: true
            };
        }

        Lampa.Player.runas(Lampa.Storage.field('player_iptv'));
        Lampa.Player.play(convert(program));
        Lampa.Player.playlist((archiveList || []).filter(function (item) { return canArchive(channel, item); }).map(convert));
    }

    function showPrograms(channel) {
        var list = programs(channel).filter(function (program) {
            return program.start <= Date.now() + 21600000 && program.stop >= Date.now() - ((channel.catchup.days || 1) * 86400000);
        }).reverse();

        if (!list.length) return notify('Для канала нет телепрограммы');

        var enabled = Lampa.Controller.enabled().name;
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

    function playerChannel(channel) {
        return {
            name: channel.name,
            group: channel.group,
            logo: channel.logo,
            url: channel.url,
            original: channel,
            icons: canArchive(channel, programs(channel)[currentProgramIndex(channel)]) ? ['↶'] : []
        };
    }

    function playLive(index) {
        var channels = state.visible;
        if (!channels.length) return;

        function getChannel(position) {
            var original = channels[position];
            var channel = playerChannel(original);
            var list = programs(original);
            var current = currentProgramIndex(original);

            setTimeout(function () {
                Lampa.Player.programReady({ channel: channel, position: current, total: list.length });
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
                showPrograms(channel.original);
            }
        });
    }

    function loadData(force) {
        if (!force && state.channels.length && Date.now() - state.loadedAt < 600000) return Promise.resolve(state);

        var playlistUrl = field('playlist');
        if (!playlistUrl) return Promise.reject(new Error('Укажите URL плейлиста в Настройки → IPTV+'));

        return requestText(playlistUrl).then(function (m3u) {
            var parsed = parseM3U(m3u);
            state.channels = parsed.channels;
            state.visible = parsed.channels.slice();
            state.groups = parsed.channels.map(function (channel) { return channel.group; }).filter(function (group, index, all) { return all.indexOf(group) === index; });
            state.playlistEpg = parsed.epgUrl;
            state.loadedAt = Date.now();

            var guideUrl = field('epg') || parsed.epgUrl;
            if (!guideUrl) {
                state.epg = {};
                state.epgNames = {};
                return state;
            }

            return requestText(guideUrl).then(function (xml) {
                var guide = parseXmltv(xml);
                state.epg = guide.epg;
                state.epgNames = guide.names;
                return state;
            }).catch(function (error) {
                console.log('IPTV+', 'EPG load error', error);
                notify('Плейлист загружен, но XMLTV недоступен');
                state.epg = {};
                state.epgNames = {};
                return state;
            });
        });
    }

    function selectGroup(component) {
        var enabled = Lampa.Controller.enabled().name;
        var items = [{ title: 'Все каналы', group: '' }].concat(state.groups.map(function (group) { return { title: group, group: group }; }));

        Lampa.Select.show({
            title: 'Категория',
            items: items,
            onSelect: function (item) {
                Lampa.Select.hide();
                component.group = item.group;
                component.build();
                component.start();
            },
            onBack: function () { Lampa.Controller.toggle(enabled); }
        });
    }

    function Component(object) {
        var self = this;
        this.object = object || {};
        this.group = '';
        this.html = $('<div class="iptv-plus-screen"><div class="iptv-plus-toolbar"></div><div class="iptv-plus-grid"></div></div>');
        this.last = null;

        this.create = function () {
            self.activity.loader(true);
            loadData(false).then(function () {
                self.build();
                self.activity.loader(false);
                self.activity.toggle();
            }).catch(function (error) {
                self.activity.loader(false);
                self.html.find('.iptv-plus-grid').html('<div class="iptv-plus-error">' + escapeHtml(error.message || error) + '</div>');
                self.buildToolbar();
                self.activity.toggle();
            });
            return self.render();
        };

        this.buildToolbar = function () {
            var toolbar = self.html.find('.iptv-plus-toolbar').empty();
            var groupButton = $('<div class="iptv-plus-button selector">Категория: <b>' + escapeHtml(self.group || 'Все каналы') + '</b></div>');
            var reloadButton = $('<div class="iptv-plus-button selector">Обновить</div>');

            groupButton.on('hover:enter', function () { selectGroup(self); });
            reloadButton.on('hover:enter', function () {
                self.activity.loader(true);
                loadData(true).then(function () {
                    self.build();
                    self.activity.loader(false);
                    self.start();
                    notify('IPTV+ обновлён');
                }).catch(function (error) {
                    self.activity.loader(false);
                    notify(error.message || 'Ошибка обновления');
                });
            });
            toolbar.append(groupButton, reloadButton);
        };

        this.build = function () {
            self.buildToolbar();
            var grid = self.html.find('.iptv-plus-grid').empty();
            state.visible = self.group ? state.channels.filter(function (channel) { return channel.group === self.group; }) : state.channels.slice();

            state.visible.forEach(function (channel, index) {
                var list = programs(channel);
                var current = list[currentProgramIndex(channel)];
                var card = $('<div class="iptv-plus-card selector"><div class="iptv-plus-logo"></div><div class="iptv-plus-card-body"><div class="iptv-plus-name">' + escapeHtml(channel.name) + '</div><div class="iptv-plus-now">' + escapeHtml(current ? current.title : channel.group) + '</div></div>' + (canArchive(channel, current) ? '<div class="iptv-plus-archive">↶</div>' : '') + '</div>');
                var logo = card.find('.iptv-plus-logo');

                if (channel.logo) logo.append('<img src="' + escapeHtml(channel.logo) + '">');
                else logo.text(channel.name.slice(0, 2).toUpperCase());

                card.on('hover:focus', function () { self.last = this; });
                card.on('hover:enter', function () { playLive(index); });
                card.on('hover:long', function () { showPrograms(channel); });
                grid.append(card);
            });

            if (!state.visible.length) grid.html('<div class="iptv-plus-error">В этой категории нет каналов</div>');
        };

        this.start = function () {
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
        this.destroy = function () { self.html.remove(); };
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
            field: { name: 'URL XMLTV', description: 'Необязательно, если url-tvg указан в M3U' }
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
                state.loadedAt = 0;
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
            '.iptv-plus-screen{padding:1.6em 2.2em 4em;min-height:100%;box-sizing:border-box}' +
            '.iptv-plus-toolbar{display:flex;gap:.8em;margin-bottom:1.2em}' +
            '.iptv-plus-button{padding:.65em 1em;background:rgba(255,255,255,.12);border-radius:.45em;font-size:1.1em}' +
            '.iptv-plus-button.focus{background:#fff;color:#111}' +
            '.iptv-plus-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8em}' +
            '.iptv-plus-card{position:relative;display:flex;align-items:center;min-height:5.3em;padding:.7em;background:rgba(255,255,255,.09);border-radius:.55em;box-sizing:border-box}' +
            '.iptv-plus-card.focus{background:#fff;color:#111;transform:scale(1.025)}' +
            '.iptv-plus-logo{width:3.7em;height:3.7em;flex:0 0 3.7em;border-radius:.45em;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-weight:700;overflow:hidden}' +
            '.iptv-plus-logo img{width:100%;height:100%;object-fit:contain}' +
            '.iptv-plus-card-body{min-width:0;margin-left:.8em}' +
            '.iptv-plus-name{font-size:1.08em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-plus-now{font-size:.82em;opacity:.58;margin-top:.35em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-plus-archive{position:absolute;right:.45em;top:.3em;font-size:1.1em;opacity:.7}' +
            '.iptv-plus-error{font-size:1.25em;line-height:1.5;padding:2em;opacity:.75}' +
            '@media(max-width:900px){.iptv-plus-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
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
