// ==UserScript==
// @name         Translate Pixiv Tags
// @author       evazion
// @version      20200112150146
// @description  Translates tags on Pixiv, Nijie, NicoSeiga, Tinami, and BCY to Danbooru tags.
// @homepageURL  https://github.com/evazion/translate-pixiv-tags
// @supportURL   https://github.com/evazion/translate-pixiv-tags/issues
// @updateURL    https://github.com/evazion/translate-pixiv-tags/raw/stable/translate-pixiv-tags.user.js
// @downloadURL  https://github.com/evazion/translate-pixiv-tags/raw/stable/translate-pixiv-tags.user.js
// @match        *://www.pixiv.net/*
// @match        *://dic.pixiv.net/*
// @match        *://nijie.info/*
// @match        *://seiga.nicovideo.jp/*
// @match        *://www.tinami.com/*
// @match        *://bcy.net/*
// @match        *://*.deviantart.com/*
// @match        *://*.hentai-foundry.com/*
// @match        *://twitter.com/*
// @match        *://tweetdeck.twitter.com/*
// @match        *://*.artstation.com/*
// @match        *://saucenao.com/*
// @match        *://pawoo.net/*
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.2.1/jquery.min.js
// @require      https://raw.githubusercontent.com/rafaelw/mutation-summary/421110f84178aa9e4098b38df83f727e5aea3d97/src/mutation-summary.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/qtip2/3.0.3/jquery.qtip.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/underscore.js/1.9.1/underscore.js
// @require      https://github.com/evazion/translate-pixiv-tags/raw/lib-20190830/lib/jquery-gm-shim.js
// @resource     jquery_qtip_css https://cdnjs.cloudflare.com/ajax/libs/qtip2/3.0.3/jquery.qtip.min.css
// @resource     danbooru_icon https://github.com/evazion/translate-pixiv-tags/raw/resource-20190903/resource/danbooru-icon.ico
// @resource     settings_icon https://github.com/evazion/translate-pixiv-tags/raw/resource-20190903/resource/settings-icon.svg
// @connect      donmai.us
// @noframes
// ==/UserScript==

/* globals MutationSummary _ GM_jQuery_setup */

"use strict";

const SETTINGS = {
    list: [
        {
            name: "booru",
            defValue: "https://danbooru.donmai.us",
            descr: "Danbooru subdomain for sending requests",
            type: "list",
            values: {
                "https://danbooru.donmai.us":   "Danbooru",
                "https://kagamihara.donmai.us": "Kagamihara",
                "https://saitou.donmai.us":     "Saitou",
                "https://shima.donmai.us":      "Shima",
                "https://safebooru.donmai.us": "Safebooru",
            },
        }, {
            name: "cache_lifetime",
            defValue: 60 * 5,
            descr:
                "The amount of time in seconds to cache data from Danbooru before querying again",
            type: "number",
        }, {
            name: "preview_limit",
            defValue: 3,
            descr: "The number of recent posts to show in artist tooltips",
            type: "number",
        }, {
            name: "show_preview_rating",
            defValue: "s",
            descr: "The upper level of rating for preview (higher ratings will be blurred)",
            type: "list",
            values: {
                s: "Safe",
                q: "Questionable",
                e: "Explicit", // eslint-disable-line id-blacklist
            },
        }, {
            name: "show_deleted",
            defValue: true,
            descr: "Check to show deleted posts, uncheck to hide",
            type: "boolean",
        },
    ],
    isValid (settingName, value) {
        const setting = this.list.find((s) => s.name === settingName);
        if (!setting) {
            console.error(`No setting ${settingName}`);
            return false;
        }
        switch (setting.type) {
            case "number": return Number.isInteger(value) && value > 0;
            case "list": return value in setting.values;
            case "boolean": return typeof value === "boolean";
            default:
                console.error(`Unsupported type ${setting.type}`);
                return false;
        }
    },
    get (settingName) {
        const setting = this.list.find((s) => s.name === settingName);
        if (!setting) {
            console.error(`No setting ${settingName}`);
            return null;
        }
        const value = GM_getValue(settingName);
        if (typeof value === "undefined" || !this.isValid(settingName, value)) {
            GM_setValue(settingName, setting.defValue);
            return setting.defValue;
        }
        return value;
    },
    set (settingName, value) {
        const setting = this.list.find((s) => s.name === settingName);
        if (!setting) {
            console.error(`No setting ${settingName}`);
            return null;
        }
        if (this.isValid(settingName, value)) {
            GM_setValue(settingName, value);
            return true;
        }
        console.warn(`Invalid value ${value} for ${settingName}`);
        return false;
    },
};

// Which domain to send requests to
const BOORU = SETTINGS.get("booru");
// How long (in seconds) to cache translated tag lookups.
const CACHE_LIFETIME = SETTINGS.get("cache_lifetime");
// Number of recent posts to show in artist tooltips.
const ARTIST_POST_PREVIEW_LIMIT = SETTINGS.get("preview_limit");
// The upper level of rating to show preview. Higher ratings will be blurred.
const SHOW_PREVIEW_RATING = SETTINGS.get("show_preview_rating");
// Whether to show deleted images in the preview or from the posts link
const SHOW_DELETED = SETTINGS.get("show_deleted");

// Values needed from Danbooru API calls using the "only" parameter
const POST_FIELDS = [
    "created_at",
    "file_size",
    "has_visible_children",
    "id",
    "image_height",
    "image_width",
    "is_flagged",
    "is_pending",
    "is_deleted",
    "parent_id",
    "preview_file_url",
    "rating",
    "source",
    "tag_string",
].join(",");
const POST_COUNT_FIELDS = "post_count";
const TAG_FIELDS = "name,category";
const WIKI_FIELDS = "title,category_name";
const ARTIST_FIELDS = "id,name,is_banned,other_names,urls";

// Settings for artist tooltips.
const ARTIST_QTIP_SETTINGS = {
    style: {
        classes: "ex-artist-tooltip",
    },
    position: {
        my: "top center",
        at: "bottom center",
    },
    show: {
        delay: 500,
        solo: true,
    },
    hide: {
        delay: 250,
        fixed: true,
        leave: false, // Prevent hiding when cursor hovers a browser tooltip
    },
};

// Domains where images outside of whitelist are blocked
const CORS_IMAGE_DOMAINS = [
    "twitter.com",
];

// For network rate and error management
const MAX_PENDING_NETWORK_REQUESTS = 40;
const MIN_PENDING_NETWORK_REQUESTS = 5;
const MAX_NETWORK_ERRORS = 25;
const MAX_NETWORK_RETRIES = 3;

const TAG_SELECTOR = ".ex-translated-tags, .ex-artist-tag";

const TAG_POSITIONS = {
    beforebegin: {
        insertTag: ($container, $elem) => $container.before($elem),
        findTag: ($container) => $container.prevAll(TAG_SELECTOR),
        getTagContainer: ($elem) => $elem.next(),
    },
    afterbegin:  {
        insertTag: ($container, $elem) => $container.prepend($elem),
        findTag: ($container) => $container.find(TAG_SELECTOR),
        getTagContainer: ($elem) => $elem.parent(),
    },
    beforeend:   {
        insertTag: ($container, $elem) => $container.append($elem),
        findTag: ($container) => $container.find(TAG_SELECTOR),
        getTagContainer: ($elem) => $elem.parent(),
    },
    afterend:    {
        insertTag: ($container, $elem) => $container.after($elem),
        findTag: ($container) => $container.nextAll(TAG_SELECTOR),
        getTagContainer: ($elem) => $elem.prev(),
    },
    afterParent: {
        insertTag: ($container, $elem) => $container.parent().after($elem),
        findTag: ($container) => $container.parent().nextAll(TAG_SELECTOR),
        getTagContainer: ($elem) => $elem.prev().find("a"),
    },
};

const PROGRAM_CSS = `
.ex-translated-tags {
    margin: 0 0.5em;
}
.ex-translated-tags * {
    display: inline !important;
    float: none !important;
    background: none !important;
    margin: 0 !important;
    padding: 0 !important;
    text-decoration: none !important;
    white-space: nowrap;
}
.ex-translated-tags::before {
    content: "(";
    white-space: nowrap;
}
.ex-translated-tags::after {
    content: ")";
    white-space: nowrap;
}
/* dirt hack for DevianArt: add :not(#id) to rapidly increase rule specificity */
.ex-translated-tag-category-5:not(#id) {
    color: #F80 !important;
}
.ex-translated-tag-category-4:not(#id) {
    color: #0A0 !important;
}
.ex-translated-tag-category-3:not(#id) {
    color: #A0A !important;
}
.ex-translated-tag-category-1:not(#id) {
    color: #A00 !important;
}
.ex-translated-tag-category-0:not(#id) {
    color: #0073ff !important;
}

.ex-artist-tag {
    white-space: nowrap;
}
.ex-artist-tag.inline {
    display: inline-block;
    margin-left: 0.5em;
}
.ex-artist-tag a:not(#id) {
    color: #A00 !important;
    margin-left: 0.3ch;
    text-decoration: none;
}
.ex-artist-tag::before {
    content: "";
    display: inline-block;
    background-image: url(${GM_getResourceURL("danbooru_icon")});
    background-repeat: no-repeat;
    background-size: 0.8em;
    width: 0.8em;
    height: 0.8em;
    vertical-align: middle;
}
.ex-banned-artist-tag a::after {
    content: " (banned)";
}

#ex-qtips {
    position: fixed;
    width: 100vw;
    height: 100vh;
    top: 0;
    pointer-events: none;
    z-index: 15000;
}
#ex-qtips > * {
    pointer-events: all;
}

.ex-artist-tooltip.qtip {
    max-width: 538px !important;
    background-color: white;
}
.ex-artist-tooltip.qtip-dark {
    background-color: black;
}
.ex-artist-tooltip .qtip-content {
    width: 520px !important;
}
`;

function memoizeKey (...args) {
    return JSON.stringify(args);
}

// Tag function for template literals to remove newlines and leading spaces
function noIndents (strings, ...values) {
    // Remove all spaces before/after a tag and leave one in other cases
    const compactStrings = strings.map((str) => (
        str.replace(
            /(>)?\n *(<)?/g,
            (s, lt, gt) => (lt && gt ? lt + gt : (lt || gt ? (lt || gt) : " ")),
        )
    ));

    const res = new Array(values.length * 2 + 1);
    // eslint-disable-next-line unicorn/no-for-loop
    for (let i = 0; i < values.length; i++) {
        res[i * 2] = compactStrings[i];
        res[i * 2 + 1] = values[i];
    }
    res[res.length - 1] = compactStrings[compactStrings.length - 1];

    return res.join("");
}

// For safe ways to use regexes in a single line of code
function safeMatch (string, regex, group = 0, defaultValue = "") {
    const match = string.match(regex);
    if (match) {
        return match[group];
    }
    return defaultValue;
}

const safeMatchMemoized = _.memoize(safeMatch, memoizeKey);

function getImage (imageUrl) {
    return GM
        .xmlHttpRequest({
            method: "GET",
            url: imageUrl,
            responseType: "blob",
        })
        .then(({ response }) => response);
}

function rateLimitedLog (level, ...messageData) {
    // Assumes that only simple arguments will be passed in
    const key = messageData.join(",");
    const options = rateLimitedLog[key] || (rateLimitedLog[key] = { log: true });

    if (options.log) {
        console[level](...messageData);
        options.log = false;
        // Have only one message with the same parameters per second
        setTimeout(() => { options.log = true; }, 1000);
    }
}

function checkNetworkErrors (domain, hasError) {
    const data = checkNetworkErrors[domain] || (checkNetworkErrors[domain] = { error: 0 });

    if (hasError) {
        console.log("Total errors:", data.error);
        data.error += 1;
    }
    if (data.error >= MAX_NETWORK_ERRORS) {
        rateLimitedLog(
            "error",
            "Maximun number of errors exceeded",
            MAX_NETWORK_ERRORS,
            "for",
            domain,
        );
        return false;
    }
    return true;
}

async function getJSONRateLimited (url, params) {
    const sleepHalfSecond = (resolve) => setTimeout(resolve, 500);
    const domain = new URL(url).hostname;
    const queries = (
        getJSONRateLimited[domain]
        || (getJSONRateLimited[domain] = {
            pending: 0,
            currentMax: MAX_PENDING_NETWORK_REQUESTS,
        })
    );

    // Wait until the number of pending network requests is below the max threshold
    /* eslint-disable no-await-in-loop */
    while (queries.pending >= queries.currentMax) {
        // Bail if the maximum number of network errors has been exceeded
        if (!(checkNetworkErrors(domain, false))) {
            return [];
        }
        rateLimitedLog(
            "warn",
            "Exceeded maximum pending requests",
            queries.currentMax,
            "for",
            domain,
        );
        await new Promise(sleepHalfSecond);
    }

    for (let i = 0; i < MAX_NETWORK_RETRIES; i++) {
        queries.pending += 1;
        try {
            return await $
                .getJSON(url, params)
                .always(() => { queries.pending -= 1; });
        } catch (ex) {
            // Backing off maximum to adjust to current network conditions
            queries.currentMax = Math.max(queries.currentMax - 1, MIN_PENDING_NETWORK_REQUESTS);
            console.error(
                "Failed try #",
                i + 1,
                "\nURL:",
                url,
                "\nParameters:",
                params,
                "\nHTTP Error:",
                ex.status,
            );
            if (!checkNetworkErrors(domain, true)) {
                return [];
            }
            await new Promise(sleepHalfSecond);
        }
    }
    /* eslint-enable no-await-in-loop */
    return [];
}

const getJSONMemoized = _.memoize(getJSONRateLimited, memoizeKey);

function get (url, params, cache = CACHE_LIFETIME, baseUrl = BOORU) {
    const finalParams = (cache > 0)
        ? {
            ...params,
            expires_in: cache,
        }
        : params;

    return getJSONMemoized(`${baseUrl}${url}.json`, finalParams)
        .catch((xhr) => {
            console.error(xhr.status, xhr);
            return [];
        });
}

async function translateTag (target, tagName, options) {
    const normalizedTag = tagName
        // .trim()
        .normalize("NFKC")
        .replace(/^#/, "")
        .replace(/[*]/g, "\\*"); // Escape * (wildcard)

    /* Don't search for empty tags. */
    if (normalizedTag.length === 0) {
        return;
    }

    const wikiPages = await get(
        "/wiki_pages",
        {
            search: {
                other_names_match: normalizedTag,
                is_deleted: false,
            },
            only: WIKI_FIELDS,
        },
    );

    let tags = [];
    if (wikiPages.length > 0) {
        tags = wikiPages.map((wikiPage) => ({
            name: wikiPage.title,
            prettyName: wikiPage.title.replace(/_/g, " "),
            category: wikiPage.category_name,
        }));
    // `normalizedTag` consists of only ASCII characters except percent, asterics, and comma
    } else if (normalizedTag.match(/^[\u0020-\u0024\u0026-\u0029\u002B\u002D-\u007F]+$/)) {
        tags = await get(
            "/tags",
            {
                search: { name: normalizedTag },
                only: TAG_FIELDS,
            },
        );
        tags = tags.map((tag) => ({
            name: tag.name,
            prettyName: tag.name.replace(/_/g, " "),
            category: tag.category,
        }));
    }

    addDanbooruTags($(target), tags, options);
}

function addDanbooruTags ($target, tags, options = {}) {
    if (tags.length === 0) return;

    const renderedTags = addDanbooruTags.cache || (addDanbooruTags.cache = {});
    const {
        onadded = null, // ($tag, options)=>{},
        tagPosition: {
            insertTag = TAG_POSITIONS.afterend.insertTag,
        } = {},
    } = options;
    let { classes = "" } = options;
    classes = `ex-translated-tags ${classes}`;

    const key = tags.map((tag) => tag.name).join("");
    if (!(key in renderedTags)) {
        renderedTags[key] = $(noIndents`
            <span class="${classes}">
                ${tags.map((tag) => (
                    noIndents`
                    <a class="ex-translated-tag-category-${tag.category}"
                       href="${BOORU}/posts?tags=${encodeURIComponent(tag.name)}"
                       target="_blank">
                            ${_.escape(tag.prettyName)}
                    </a>`
                ))
                .join(", ")}
            </span>`);
    }
    const $tagsContainer = renderedTags[key].clone().prop("className", classes);
    insertTag($target, $tagsContainer);

    if (onadded) onadded($tagsContainer, options);
}

async function translateArtistByURL (element, profileUrl, options) {
    if (!profileUrl) return;

    const artists = await get(
        "/artists",
        {
            search: {
                url_matches: profileUrl,
                is_active: true,
            },
            only: ARTIST_FIELDS,
        },
    );
    artists.forEach((artist) => addDanbooruArtist($(element), artist, options));
}

async function translateArtistByName (element, artistName, options) {
    if (!artistName) return;

    const artists = await get(
        "/artists",
        {
            search: {
                name: artistName.replace(/ /g, "_"),
                is_active: true,
            },
            only: ARTIST_FIELDS,
        },
    );

    artists.forEach((artist) => addDanbooruArtist($(element), artist, options));
}

function addDanbooruArtist ($target, artist, options = {}) {
    const renderedArtists = addDanbooruArtist.cache || (addDanbooruArtist.cache = {});
    const {
        onadded = null, // ($tag, options)=>{},
        tagPosition: {
            insertTag = TAG_POSITIONS.afterend.insertTag,
            findTag = TAG_POSITIONS.afterend.findTag,
        } = {},
    } = options;
    let { classes = "" } = options;

    classes += artist.is_banned ? " ex-artist-tag ex-banned-artist-tag" : " ex-artist-tag";
    /* eslint-disable no-param-reassign */
    artist.prettyName = artist.name.replace(/_/g, " ");
    artist.escapedName = _.escape(artist.prettyName);
    artist.encodedName = encodeURIComponent(artist.name);
    /* eslint-enable no-param-reassign */

    const qtipSettings = Object.assign(ARTIST_QTIP_SETTINGS, {
        content: { text: (ev, qtip) => buildArtistTooltip(artist, qtip) },
    });

    const $duplicates = findTag($target)
        .filter((i, el) => el.textContent.trim() === artist.escapedName);
    if ($duplicates.length > 0) {
        // If qtip was removed then add it back
        if (!$.data($duplicates.find("a")[0]).qtip) {
            $duplicates.find("a").qtip(qtipSettings);
        }
        return;
    }

    if (!(artist.id in renderedArtists)) {
        renderedArtists[artist.id] = $(noIndents`
            <div class="${classes}">
                <a href="${BOORU}/artists/${artist.id}" target="_blank">
                    ${artist.escapedName}
                </a>
            </div>`);
    }
    const $tag = renderedArtists[artist.id].clone().prop("className", classes);
    insertTag($target, $tag);
    $tag.find("a").qtip(qtipSettings);

    if (onadded) onadded($tag, options);
}

function attachShadow ($target, $content) {
    // Return if the target already have shadow
    if ($target.prop("shadowRoot")) return;

    if (_.isFunction(document.body.attachShadow)) {
        const shadowRoot = $target.get(0).attachShadow({ mode: "open" });
        $(shadowRoot).append($content);
    } else {
        $target.empty().append($content);
    }
}

function chooseBackgroundColorScheme ($element) {
    const TRANSPARENT_COLOR = "rgba(0, 0, 0, 0)";
    // Halfway between white/black in the RGB scheme
    const MIDDLE_LUMINOSITY = 128;

    // Get background colors of all parent elements with a nontransparent background color
    const backgroundColors = $element.parents()
        .map((i, el) => $(el).css("background-color"))
        .get()
        .filter((color) => color !== TRANSPARENT_COLOR);
    // Calculate summary color and get RGB channels
    const colorChannels = backgroundColors
        .map((color) => color.match(/\d+/g))
        .reverse()
        .reduce(([r1, g1, b1], [r2, g2, b2, al = 1]) => [
            r1 * (1 - al) + r2 * al,
            g1 * (1 - al) + g2 * al,
            b1 * (1 - al) + b2 * al,
        ])
        .slice(0, 3); // Ignore alpha
    const medianLuminosity = (Math.max(...colorChannels) + Math.min(...colorChannels)) / 2;
    const adjustedChannels = colorChannels.map((color) => {
        const colorScale = (color - MIDDLE_LUMINOSITY) / MIDDLE_LUMINOSITY; // To range [-1..+1]
        return Math.round(
            (Math.abs(colorScale) ** 0.7)            // "Move" value away from 0 which equal to 128
            * Math.sign(colorScale)                  // Get original sign back
            * MIDDLE_LUMINOSITY + MIDDLE_LUMINOSITY, // Get back to the RGB range [0..255]
        );
    });
    const adjustedColor = `rgb(${adjustedChannels.join(", ")})`;
    const qtipClass = (medianLuminosity < MIDDLE_LUMINOSITY ? "qtip-dark" : "qtip-light");
    return {
        qtipClass,
        adjustedColor,
    };
}

async function buildArtistTooltip (artist, qtip) {
    const renderedQtips = buildArtistTooltip.cache || (buildArtistTooltip.cache = {});

    if (!(artist.name in renderedQtips)) {
        const waitPosts = get(
            "/posts",
            {
                tags: `${(SHOW_DELETED ? "status:any" : "-status:deleted")} ${artist.name}`,
                limit: ARTIST_POST_PREVIEW_LIMIT,
                only: POST_FIELDS,
            },
        );
        const waitTags = get(
            "/tags",
            {
                search: { name: artist.name },
                only: POST_COUNT_FIELDS,
            },
        );

        renderedQtips[artist.name] = Promise
            .all([waitTags, waitPosts])
            .then(([tags, posts]) => buildArtistTooltipContent(artist, tags, posts));
    }

    if (
        !qtip.elements.tooltip.hasClass("qtip-dark")
        && !qtip.elements.tooltip.hasClass("qtip-light")
    ) {
        // Select theme and background color based upon the background of surrounding elements
        const { qtipClass, adjustedColor } = chooseBackgroundColorScheme(qtip.elements.target);
        qtip.elements.tooltip.addClass(qtipClass);
        qtip.elements.tooltip.css("background-color", adjustedColor);
    }

    let $qtipContent = (await renderedQtips[artist.name]);
    // For correct work of CORS images must not be cloned at first displaying
    if ($qtipContent.parent().length > 0) $qtipContent = $qtipContent.clone(true, true);
    attachShadow(qtip.elements.content, $qtipContent);
    qtip.reposition(null, false);
}

function buildArtistTooltipContent (artist, [tag = { post_count: 0 }], posts = []) {
    const otherNames = artist.other_names
        .filter(String)
        .sort()
        .map((otherName) => (
            noIndents`
            <li>
                <a href="${BOORU}/artists?search[name]=${encodeURIComponent(otherName)}"
                   target="_blank">
                    ${_.escape(otherName.replace(/_/g, " "))}
                </a>
            </li>`
        ))
        .join("");

    const $content = $(noIndents`
        <style>
            :host {
                --preview_has_children_color: #0F0;
                --preview_has_parent_color: #CC0;
                --preview_deleted_color: #000;
                --preview_pending_color: #00F;
                --preview_flagged_color: #F00;
            }

            article.container {
                font-family: Verdana, Helvetica, sans-serif;
                padding: 10px;
            }

            section {
                margin-bottom: 15px;
            }

            h2 {
                font-size: 14px;
                font-weight: bold;
                margin-bottom: 5px;
            }

            a.artist-name {
                font-size: 20px;
            }

            .post-count {
                color: #888;
                margin-left: 3px;
            }

            ul.other-names {
                margin-top: 5px;
                line-height: 24px;
                padding: 0px;
                max-height: 48px;
            }

            ul.other-names li {
                display: inline;
            }

            ul.other-names li a {
                background-color: rgba(128,128,128,0.2);
                padding: 3px 5px;
                margin: 0 2px;
                border-radius: 3px;
                white-space: nowrap;
            }

            section.urls ul {
                list-style: disc inside;
                padding: 0px;
                max-height: 145px;
            }

            section.urls ul li.artist-url-inactive a {
                color: red;
                text-decoration: underline;
                text-decoration-style: dotted;
            }


            /* Basic styles taken from Danbooru */
            a:link, a:visited {
                color: #0073FF;
                text-decoration: none;
            }

            a:hover {
                color: #80B9FF;
            }

            a.tag-category-artist {
                color: #A00;
            }

            a.tag-category-artist:hover {
                color: #B66;
            }



            /* Thumbnail styles taken from Danbooru */
            article.post-preview {
                /*height: 154px;*/
                width: 154px;
                margin: 0 10px 10px 0;
                float: left;
                overflow: hidden;
                text-align: center;
                position: relative;
            }

            article.post-preview a {
                margin: auto;
                border: 2px solid transparent;
                display: inline-block;
            }

            article.post-preview.post-status-has-children a {
                border-color: var(--preview_has_children_color);
            }

            article.post-preview.post-status-has-parent a {
                border-color: var(--preview_has_parent_color);
            }

            article.post-preview.post-status-has-children.post-status-has-parent a {
                border-color: var(--preview_has_children_color)
                              var(--preview_has_parent_color)
                              var(--preview_has_parent_color)
                              var(--preview_has_children_color);
            }

            article.post-preview.post-status-deleted a {
                border-color: var(--preview_deleted_color);
            }

            article.post-preview.post-status-has-children.post-status-deleted a {
                border-color: var(--preview_has_children_color)
                              var(--preview_deleted_color)
                              var(--preview_deleted_color)
                              var(--preview_has_children_color);
            }

            article.post-preview.post-status-has-parent.post-status-deleted a {
                border-color: var(--preview_has_parent_color)
                              var(--preview_deleted_color)
                              var(--preview_deleted_color)
                              var(--preview_has_parent_color);
            }

            article.post-preview.post-status-has-children.post-status-has-parent.post-status-deleted a {
                border-color: var(--preview_has_children_color)
                              var(--preview_deleted_color)
                              var(--preview_deleted_color)
                              var(--preview_has_parent_color);
            }

            article.post-preview.post-status-pending a,
            article.post-preview.post-status-flagged a {
                border-color: var(--preview_pending_color);
            }

            article.post-preview.post-status-has-children.post-status-pending a,
            article.post-preview.post-status-has-children.post-status-flagged a {
                border-color: var(--preview_has_children_color)
                              var(--preview_pending_color)
                              var(--preview_pending_color)
                              var(--preview_has_children_color);
            }

            article.post-preview.post-status-has-parent.post-status-pending a,
            article.post-preview.post-status-has-parent.post-status-flagged a {
                border-color: var(--preview_has_parent_color)
                              var(--preview_pending_color)
                              var(--preview_pending_color)
                              var(--preview_has_parent_color);
            }

            article.post-preview.post-status-has-children.post-status-has-parent.post-status-pending a,
            article.post-preview.post-status-has-children.post-status-has-parent.post-status-flagged a {
                border-color: var(--preview_has_children_color)
                              var(--preview_pending_color)
                              var(--preview_pending_color)
                              var(--preview_has_parent_color);
            }

            article.post-preview[data-tags~=animated]:before {
                content: "►";
                position: absolute;
                width: 20px;
                height: 20px;
                color: white;
                background-color: rgba(0,0,0,0.5);
                margin: 2px;
                text-align: center;
            }

            article.post-preview[data-has-sound=true]:before {
                content: "♪";
                position: absolute;
                width: 20px;
                height: 20px;
                color: white;
                background-color: rgba(0,0,0,0.5);
                margin: 2px;
                text-align: center;
            }


            div.post-list {
                display: flex;
                flex-wrap: wrap;
                max-height: 420px;
                align-items: flex-end;
            }

            article.post-preview a {
                display: inline-block;
                /*height: 154px;*/
                overflow: hidden;
            }

            article.post-preview img {
                margin-bottom: -2px;
            }

            article.post-preview p {
                text-align: center;
                margin: 0 0 2px 0;
            }

            article.post-preview.blur-post img {
                filter: blur(10px);
            }

            article.post-preview.blur-post:hover img {
                filter: blur(0px);
                transition: filter 1s 0.5s;
            }

            .scrollable {
                overflow: auto;
            }
            .scrollable::-webkit-scrollbar {
                width: 6px;
            }

            .scrollable::-webkit-scrollbar-track {
                background-color: rgba(128,128,128,0.2);
                border-radius: 6px;
            }

            .scrollable::-webkit-scrollbar-thumb {
                background-color: rgba(128,128,128,0.4);
                border-radius: 6px;
            }

            .settings-icon {
                position:absolute;
                top: 10px;
                right: 10px;
                width: 16px;
                height: 16px;
                cursor: pointer;
            }
            .settings-icon path {
                fill: #888;
            }
        </style>

        <article class="container" part="container">
            ${GM_getResourceText("settings_icon")}
            <section class="header">
                <a class="artist-name tag-category-artist"
                   href="${BOORU}/artists/${artist.id}"
                   target="_blank">
                    ${_.escape(artist.prettyName)}
                </a>
                <span class="post-count">${tag.post_count}</span>

                <ul class="other-names scrollable" part="other-names">
                    ${otherNames}
                </ul>
            </section>
            <section class="urls">
                <h2>
                    URLs
                    (<a href="${BOORU}/artists/${artist.id}/edit" target="_blank">edit</a>)
                </h2>
                <ul class="scrollable" part="url-list">
                    ${buildArtistUrlsHtml(artist)}
                </ul>
            </section>
            <section class="posts">
                <h2>
                    Posts
                    <a href="${BOORU}/posts?tags=${artist.encodedName}+${(SHOW_DELETED ? "status%3Aany" : "-status%3Adeleted")}" target="_blank">»</a>
                </h2>
                <div class="post-list scrollable" part="post-list"></div>
            </section>
        </article>
    `);
    $content.find(".post-list").append(posts.map(buildPostPreview));
    $content.find(".settings-icon").click(showSettings);
    return $content;
}

function buildArtistUrlsHtml (artist) {
    const getDomain = (url) => safeMatchMemoized(new URL(url.normalized_url).host, /[^.]*\.[^.]*$/);
    const artistUrls = _(artist.urls)
        .chain()
        .uniq("normalized_url")
        .sortBy("normalized_url")
        .sortBy(getDomain)
        .sortBy((artistUrl) => !artistUrl.is_active);

    return artistUrls
        .map((artistUrl) => {
            const normalizedUrl = artistUrl.normalized_url.replace(/\/$/, "");
            const urlClass = artistUrl.is_active ? "artist-url-active" : "artist-url-inactive";

            return noIndents`
                <li class="${urlClass}">
                    <a href="${normalizedUrl}" target="_blank">
                        ${_.escape(normalizedUrl)}
                    </a>
                </li>`;
        })
        .join("");
}

function timeToAgo (time) {
    const interval = new Date(Date.now() - new Date(time));
    if (interval < 60000) return "less than a minute ago";
    const ranks = [{
        value: interval.getUTCFullYear() - 1970,
        unit: "year",
    }, {
        value: interval.getUTCMonth(),
        unit: "month",
    }, {
        value: interval.getUTCDate() - 1,
        unit: "day",
    }, {
        value: interval.getUTCHours(),
        unit: "hour",
    }, {
        value: interval.getUTCMinutes(),
        unit: "minute",
    }];
    const rank = ranks.find(({ value }) => value);
    if (rank.value) {
        return `${rank.value} ${(rank.value > 1 ? `${rank.unit}s` : rank.unit)} ago`;
    }
    return "∞ ago";
}

// Based on https://stackoverflow.com/questions/15900485
function formatBytes (bytes) {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / (1024 ** i)).toFixed(2))} ${sizes[i]}`;
}

function buildPostPreview (post) {
    const RATINGS = {
        s: 0,
        q: 1,
        e: 2, // eslint-disable-line id-blacklist
    };
    const previewFileUrl = `${BOORU}/images/download-preview.png`;

    let previewClass = "post-preview";
    if (post.is_pending)           previewClass += " post-status-pending";
    if (post.is_flagged)           previewClass += " post-status-flagged";
    if (post.is_deleted)           previewClass += " post-status-deleted";
    if (post.parent_id)            previewClass += " post-status-has-parent";
    if (post.has_visible_children) previewClass += " post-status-has-children";
    if (RATINGS[post.rating] > RATINGS[SHOW_PREVIEW_RATING]) {
        previewClass += " blur-post";
    }

    const dataAttributes = `
      data-id="${post.id}"
      data-has-sound="${Boolean(post.tag_string.match(/(video_with_sound|flash_with_sound)/))}"
      data-tags="${_.escape(post.tag_string)}"
    `;

    const scale = Math.min(150 / post.image_width, 150 / post.image_height, 1);
    const width = Math.round(post.image_width * scale);
    const height = Math.round(post.image_height * scale);

    const domain = post.source.match(/^https?:\/\//)
        ? new URL(post.source).hostname
            .split(".")
            .slice(-2)
            .join(".")
        : "NON-WEB";
    const imgSize = [post.file_size, post.image_width, post.image_height].every(_.isFinite)
        ? `${formatBytes(post.file_size)} (${post.image_width}x${post.image_height})`
        : "";

    const $preview = $(noIndents`
        <article itemscope
                 itemtype="http://schema.org/ImageObject"
                 class="${previewClass}"
                 ${dataAttributes} >
            <a href="${BOORU}/posts/${post.id}" target="_blank">
                <img width="${width}"
                     height="${height}"
                     src="${previewFileUrl}"
                     title="${_.escape(post.tag_string)}"
                     part="post-preview rating-${post.rating}">
            </a>
            <p>${imgSize}</p>
            <p style="letter-spacing: -0.1px;">${domain}, rating:${post.rating.toUpperCase()}</p>
            <p>${timeToAgo(post.created_at)}</p>
        </article>
    `);

    if (post.preview_file_url && !post.preview_file_url.endsWith("/images/download-preview.png")) {
        if (CORS_IMAGE_DOMAINS.includes(window.location.host)) {
            // Temporaly set transparent 1x1 image
            $preview.find("img").prop("src", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
            getImage(post.preview_file_url).then((blob) => {
                const imageBlob = blob.slice(0, blob.size, "image/jpeg");
                const blobUrl = window.URL.createObjectURL(imageBlob);
                $preview.find("img").prop("src", blobUrl);
            });
        } else {
            $preview.find("img").prop("src", post.preview_file_url);
        }
    } else {
        $preview.find("img").prop({
            width: 150, height: 150,
        });
    }

    return $preview;
}

function showSettings () {
    function settingToInput (setting) {
        const value = SETTINGS.get(setting.name);
        switch (setting.type) {
            case "number":
                return noIndents`
                    <input type="number"
                           min="0"
                           value="${value}"
                           name="${setting.name}" />`;
            case "list": {
                const options = Object
                    .entries(setting.values)
                    .map(([val, descr]) => noIndents`
                        <option value="${val}" ${val === value ? "selected" : ""}>
                            ${descr}
                        </option>`)
                    .join("");

                return noIndents`
                    <select name="${setting.name}">
                        ${options}
                    </select>`;
            }
            case "boolean":
                return noIndents`
                    <input type="checkbox"
                           ${value ? "checked" : ""}
                           name="${setting.name}" />`;
            default:
                console.error(`Unsupported type ${setting.type}`);
                return "";
        }
    }

    const $shadowContainer = $("<div>").appendTo("#ex-qtips");

    function closeSettings () {
        $shadowContainer.remove();
        $(document).off("keydown", closeSettingsOnEscape);
    }

    function closeSettingsOnEscape (ev) {
        if (ev.key === "Escape" && !ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
            closeSettings();
            return false;
        }
        return true;
    }

    const $settings = $(noIndents`
        <style>
            #ui-settings {
                width: 100vw;
                height: 100vh;
                background: rgba(0,0,0,0.25);
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                z-index: 16000;
            }
            #ui-settings.qtip-dark {
                background: rgba(0,0,0,0.75);
            }
            .container {
                padding: 20px;
                display: grid;
                grid-template-columns: 300px 1fr;
                grid-gap: 10px;
                font-size: 12px;
            }
            .qtip-light .container {
                background-color: #fff;
                color: #222;
            }
            .qtip-dark .container {
                background-color: #222;
                color: #fff;
            }
            .container div:nth-of-type(even) {
                display: flex;
                flex-direction: column-reverse;
            }
            .container h2 {
                grid-column: span 2;
                margin: auto;
            }
            input[type="button"] {
                margin: 0 5px;
            }
        </style>
        <div id="ui-settings">
            <div class="container">
                <h2>Translate Pixiv Tags settings</h2>
                ${SETTINGS.list
                    .map((setting) => (
                        noIndents`
                        <div>${setting.descr}:</div>
                        <div>${settingToInput(setting)}</div>`
                    ))
                    .join("")
                }
                <h2>
                    <input class="cancel" type="button" value="Cancel" />
                    <input class="refresh-page"
                           type="button"
                           value="Refresh page to apply changes"
                           disabled />
                </h2>
            </div>
        </div>
    `);

    $settings.click((ev) => {
        if ($(ev.target).is("#ui-settings")) closeSettings();
    });
    $settings.find("input[type='number'], input[type='checkbox'], select").change((ev) => (
        $settings.find(".refresh-page").removeAttr("disabled")
    ));
    $settings.find(".refresh-page").click((ev) => {
        $settings.find("input[type='number'], input[type='checkbox'], select").each((i, el) => {
            const $input = $(el);
            let value = null;
            if ($input.is("select")) {
                value = $input.val();
            } else if ($input.prop("type") === "number") {
                value = Number($input.val());
            } else if ($input.prop("type") === "checkbox") {
                value = $input.prop("checked");
            } else {
                return;
            }
            SETTINGS.set($input.prop("name"), value);
        });
        closeSettings();
        window.location.reload();
    });
    $settings.find(".cancel").click(closeSettings);
    $(document).keydown(closeSettingsOnEscape);

    const { qtipClass } = chooseBackgroundColorScheme($("#ex-qtips"));
    $settings.addClass(qtipClass);

    attachShadow($shadowContainer, $settings);
}

function findAndTranslate (mode, selector, options = {}) {
    const fullOptions = {
        asyncMode: false,
        requiredAttributes: null,
        predicate: null, // (el) => true,
        toProfileUrl: (el) => $(el).closest("a").prop("href"),
        toTagName: (el) => el.textContent,
        tagPosition: TAG_POSITIONS.afterend,
        classes: "",
        onadded: null, // ($tag, options) => {},
        mode,
        ...options,
    };

    if (typeof fullOptions.predicate === "string") {
        const predicateSelector = fullOptions.predicate;
        fullOptions.predicate = (el) => $(el).is(predicateSelector);
    }

    const { translate, getData } = (function fn () {
        switch (mode) {
            case "artist":
                return {
                    translate: translateArtistByURL,
                    getData: fullOptions.toProfileUrl,
                };
            case "artistByName":
                return {
                    translate: translateArtistByName,
                    getData: fullOptions.toTagName,
                };
            case "tag":
                return {
                    translate: translateTag,
                    getData: fullOptions.toTagName,
                };
            default:
                throw new Error(`Unsupported mode ${mode}`);
        }
    }());

    const tryToTranslate = (elem) => {
        if (!fullOptions.predicate || fullOptions.predicate(elem)) {
            translate(elem, getData(elem), fullOptions);
        }
    };

    $(selector).each((i, elem) => tryToTranslate(elem));

    if (!fullOptions.asyncMode) return;

    const query = { element: selector };
    if (fullOptions.requiredAttributes) query.elementAttributes = fullOptions.requiredAttributes;
    new MutationSummary({
        queries: [query],
        callback: ([summary]) => {
            let elems = summary.added;
            if (summary.attributeChanged) {
                elems = elems.concat(Object.values(summary.attributeChanged).flat(1));
            }
            elems.forEach(tryToTranslate);
        },
    });
}

function deleteOnChange (targetSelector) {
    return ($tag, options) => {
        const $container = options.tagPosition.getTagContainer($tag);
        const watcher = new MutationSummary({
            rootNode: $container.find(targetSelector)[0],
            queries: [{ characterData: true }],
            callback: ([summary]) => {
                options.tagPosition.findTag($container).remove();
                watcher.disconnect();
            },
        });
    };
}

function linkInChildren (el) {
    return $(el).find("a").prop("href");
}

/* https://twitter.com/search?q=%23ガルパン版深夜のお絵描き60分一本勝負 */
/* #艦これ版深夜のお絵描き60分一本勝負 search query for TweetDeck */
const COMMON_HASHTAG_REGEXES = [
    /生誕祭\d*$/,
    /誕生祭\d*$/,
    /版もうひとつの深夜の真剣お絵描き60分一本勝負(?:_\d+$|$)/,
    /版深夜の真剣お絵描き60分一本勝負(?:_\d+$|$)/,
    /深夜の真剣お絵描き60分一本勝負(?:_\d+$|$)/,
    /版深夜のお絵描き60分一本勝負(?:_\d+$|$)/,
    /版真剣お絵描き60分一本勝(?:_\d+$|$)/,
    /版お絵描き60分一本勝負(?:_\d+$|$)/,
];
const getNormalizedHashtagName = (el) => {
    const tagName = el.textContent;
    // eslint-disable-next-line no-restricted-syntax
    for (const regexp of COMMON_HASHTAG_REGEXES) {
        const normalizedTagName = tagName.replace(regexp, "");
        if (normalizedTagName !== tagName) {
            if (normalizedTagName !== "") {
                return normalizedTagName;
            }
            break;
        }
    }
    return tagName;
};

function initializePixiv () {
    GM_addStyle(`
        /* Fix https://www.pixiv.net/tags.php to display tags as vertical list. */
        .tag-list.slash-separated li {
            display: block;
        }
        .tag-list.slash-separated li + li:before {
            content: none;
        }
        /* Hide Pixiv's translated tags  */
        .ex-translated-tags + div,
        .ex-translated-tags + span .gtm-new-work-romaji-tag-event-click,
        .ex-translated-tags + span .gtm-new-work-translate-tag-event-click {
            display: none;
        }
        /* Remove hashtags from translated tags */
        a.tag-value::before,
        span.ex-translated-tags a::before,
        figcaption li > span:first-child > a::before {
            content: "";
        }
        /* Fix styles for tags on search page */
        div + .ex-translated-tags {
            font-size: 20px;
            font-weight: bold;
        }
        /**
         * On the artist profile page, render the danbooru artist tag
         * between the artist's name and follower count.
         */
        div._3_qyP5m {
            display: grid;
            grid-auto-rows: 16px;
            grid-template-columns: auto 1fr;
            justify-items: start;
        }
        ._3_qyP5m a[href^="/premium"] {
            grid-area: 1 / 2;
        }
        ._3_qyP5m .ex-artist-tag {
            grid-area: span 1 / span 2;
        }
        /* Illust page: fix locate artist tag to not trigger native tooltip */
        main+aside>section>h2 {
            position: relative;
        }
        h2>div>div {
            margin-bottom: 16px;
        }
        main+aside>section>h2 .ex-artist-tag {
            position: absolute;
            bottom: 0;
            left: 47px;
        }
        /* Illust page: fix artist tag overflowing in related works and on search page */
        section li>div>div:nth-child(3),
        aside li>div>div:nth-child(3) {
            flex-direction: column;
            align-items: flex-start;
        }
        section li .ex-artist-tag,
        aside li .ex-artist-tag {
            margin-left: 2px;
            margin-top: -6px;
        }
    `);

    // To remove smth like `50000users入り`, e.g. here https://www.pixiv.net/en/artworks/68318104
    const getNormalizedTagName = (el) => el.textContent.replace(/\d+users入り$/, "");

    findAndTranslate("tag", [
        // https://www.pixiv.net/bookmark_add.php?type=illust&illust_id=123456
        ".tag-cloud .tag",
        // https://www.pixiv.net/tags.php
        // https://www.pixiv.net/novel/tags.php
        ".tag-list li .tag-value",
    ].join(", "), {
        toTagName: getNormalizedTagName,
    });

    // https://dic.pixiv.net/a/東方
    findAndTranslate("tag", "#content_title #article-name", {
        tagPosition: TAG_POSITIONS.beforeend,
        toTagName: getNormalizedTagName,
    });

    // Tags on work pages: https://www.pixiv.net/en/artworks/66475847
    findAndTranslate("tag", "span", {
        predicate: "figcaption li > span:first-child",
        toTagName: getNormalizedTagName,
        asyncMode: true,
    });

    // New search pages: https://www.pixiv.net/en/tags/%E6%9D%B1%E6%96%B9project/artworks
    findAndTranslate("tag", "div", {
        predicate: "#root>div>div>div>div>div:has(span:last-child:not(.ex-translated-tags))",
        toTagName: getNormalizedTagName,
        asyncMode: true,
    });

    // Illust author https://www.pixiv.net/en/artworks/66475847
    findAndTranslate("artist", "a", {
        predicate: "main+aside>section>h2>div>div>a",
        requiredAttributes: "href",
        tagPosition: {
            insertTag: ($container, $elem) => $container.closest("h2").append($elem),
            findTag: ($container) => $container.closest("h2").find(TAG_SELECTOR),
            getTagContainer: ($elem) => $elem.prev().find("a:eq(1)"),
        },
        asyncMode: true,
        onadded: deleteOnChange("div"),
    });

    // Related work's artists https://www.pixiv.net/en/artworks/66475847
    // New search pages: https://www.pixiv.net/en/tags/%E6%9D%B1%E6%96%B9project/artworks
    findAndTranslate("artist", "a", {
        predicate: "section>div>ul>li>div>div:last-child>div:first-child>a",
        tagPosition: TAG_POSITIONS.afterParent,
        asyncMode: true,
    });

    // Artist profile pages: https://www.pixiv.net/en/users/29310, https://www.pixiv.net/en/users/104471/illustrations
    const normalizePageUrl = () => `https://www.pixiv.net/en/users/${safeMatch(window.location.pathname, /\d+/)}`;
    findAndTranslate("artist", ".VyO6wL2", {
        toProfileUrl: normalizePageUrl,
        asyncMode: true,
    });

    // Posts of followed artists: https://www.pixiv.net/bookmark_new_illust.php
    findAndTranslate("artist", ".ui-profile-popup", {
        predicate: "figcaption._3HwPt89 > ul > li > a.ui-profile-popup",
        asyncMode: true,
    });

    // Ranking pages: https://www.pixiv.net/ranking.php?mode=original
    findAndTranslate("artist", "a.user-container.ui-profile-popup", {
        asyncMode: true,
    });

    // Index page popup card
    findAndTranslate("artist", "a.user-name", {
        classes: "inline",
        asyncMode: true,
    });

    // Illust page popup card
    findAndTranslate("artist", "a", {
        predicate: "div[role='none'] a:not([class]):not([style])",
        asyncMode: true,
    });

    // Index page https://www.pixiv.net/ https://www.pixiv.net/en/
    findAndTranslate("artist", "a.user", {
        predicate: [
            ".gtm-illust-recommend-zone a",
            ".following-new-illusts a",
            ".everyone-new-illusts a",
            ".booth-follow-items a",
        ].join(","),
    });
}

function initializeNijie () {
    GM_addStyle(`
        .ex-translated-tags {
            font-family: Verdana, Helvetica, sans-serif;
        }
        /* Fix tag lists in http://nijie.info/view.php?id=203787 pages. */
        #dojin_left #view-tag .tag {
            white-space: nowrap;
            border: 0;
        }
    `);

    // http://nijie.info/view.php?id=208491
    findAndTranslate("artist", "#pro .user_icon .name, .popup_member > a");

    // http://nijie.info/view.php?id=208491
    findAndTranslate("tag", ".tag .tag_name a:first-child", {
        tagPosition: TAG_POSITIONS.beforeend,
    });

    // https://nijie.info/dic/seiten/d/東方
    findAndTranslate("tag", "#seiten_dic h1#dic_title", {
        tagPosition: TAG_POSITIONS.beforeend,
    });
}

function initializeTinami () {
    GM_addStyle(`
        .ex-translated-tags {
            font-family: Verdana, Helvetica, sans-serif;
            float: none !important;
            display: inline !important;
        }
    `);

    // http://www.tinami.com/view/979474
    findAndTranslate("tag", ".tag > span > a:nth-child(2)");

    // Triggers on http://www.tinami.com/creator/profile/10262
    findAndTranslate("artist", "div.cre_name h1", {
        toProfileUrl: (el) => window.location.href,
        tagPosition: TAG_POSITIONS.beforeend,
        classes: "inline",
    });

    // Triggers on http://www.tinami.com/view/934323
    findAndTranslate("artist", "p:has(>a[href^='/creator/profile/'])", {
        toProfileUrl: linkInChildren,
    });
}

function initializeNicoSeiga () {
    GM_addStyle(`
        /* Fix tags in http://seiga.nicovideo.jp/seiga/im7626097 */
        .illust_tag .tag {
            background: #ebebeb;
            height: auto;
            margin: 0 10px 5px 0;
        }
        /* Fix artist tag in http://seiga.nicovideo.jp/seiga/im6950870 */
        .im_head_bar .inner .user ul .user_link .ex-artist-tag a {
            display: inline-block;
            border: none;
            background: none;
            padding: 0;
        }
    `);

    // http://seiga.nicovideo.jp/tag/艦これ
    findAndTranslate("tag", "h1:has(.icon_tag_big)", {
        tagPosition: TAG_POSITIONS.beforeend,
    });

    // http://seiga.nicovideo.jp/seiga/im7741859
    findAndTranslate("tag", "a", {
        predicate: ".tag > a",
        tagPosition: TAG_POSITIONS.beforeend,
        asyncMode: true,
    });

    // http://seiga.nicovideo.jp/user/illust/14767435
    findAndTranslate("artist", ".user_info h1 a", {
        classes: "inline",
    });

    // http://seiga.nicovideo.jp/seiga/im7741859
    findAndTranslate("artist", ".user_link > a .user_name", {
        tagPosition: TAG_POSITIONS.beforeend,
    });
}

function initializeBCY () {
    // Prfile page https://bcy.net/u/3935930
    findAndTranslate("artist", "div.user-info-name", {
        toProfileUrl: (el) => $(el).closest(".user-info").find("a.avatar-user").prop("href"),
        tagPosition: TAG_POSITIONS.beforeend,
        classes: "inline",
    });

    // Illust pages https://bcy.net/item/detail/6643704430988361988
    findAndTranslate("artist", ".js-userTpl .user-name a", {
        toProfileUrl: (el) => el.href.replace(/\?.*$/, ""),
    });

    // Search pages https://bcy.net/tags/name/看板娘
    findAndTranslate("artist", "a.title-txt", {
        toProfileUrl: (el) => el.href.replace(/\?.*$/, ""),
        tagPosition: TAG_POSITIONS.beforeend,
        classes: "inline",
        asyncMode: true,
    });

    // Search pages https://bcy.net/tags/name/看板娘
    findAndTranslate("tag", ".circle-desc-name, .tag", {
        tagPosition: TAG_POSITIONS.beforeend,
        asyncMode: true,
    });

    // Illust pages https://bcy.net/item/detail/6561698116674781447
    findAndTranslate("tag", ".dm-tag-a", { tagPosition: TAG_POSITIONS.beforeend });
}

function initializeDeviantArt () {
    GM_addStyle(`
        .AEPha + .ex-artist-tag {
            margin-bottom: 0.3em;
            font-weight: bold;
        }
        .ex-artist-tag + div._2Xb_O {
            margin-top: 0;
        }
        .ex-artist-tag {
            font-weight: bold;
        }
    `);

    // Old design
    if ($("body > div#output").length > 0) {
        // https://www.deviantart.com/koyorin
        // https://www.deviantart.com/koyorin/art/Ruby-570526828
        findAndTranslate(
            "artist",
            ".gruserbadge .username, .dev-title-container .author .username",
            { classes: "inline" },
        );

        findAndTranslate("tag", ".dev-about-tags-cc .discoverytag");

        return;
    }

    // New design

    // Profile page
    // https://www.deviantart.com/adsouto
    findAndTranslate("artist", "div", {
        toProfileUrl: linkInChildren,
        predicate: "#content-container>div>div>div>div>div:has(a.user-link)",
        asyncMode: true,
    });

    // Post page
    // https://www.deviantart.com/koyorin/art/Ruby-570526828
    findAndTranslate("artist", "a.user-link", {
        predicate: "div[data-hook='deviation_meta'] a.user-link:not(:has(img))",
        requiredAttributes: "href",
        tagPosition: TAG_POSITIONS.afterParent,
        classes: "inline",
        asyncMode: true,
        onadded: deleteOnChange("span"),
    });

    // Popup card
    findAndTranslate("artist", "a.user-link", {
        predicate: "body > div:not(#root) a.user-link:not(:has(img))",
        asyncMode: true,
    });

    findAndTranslate("tag", "span", {
        predicate: "a[href^='https://www.deviantart.com/tag/'] > span:first-child",
        asyncMode: true,
    });
}

function initializeHentaiFoundry () {
    // Posts on https://www.hentai-foundry.com/user/DrGraevling/profile
    findAndTranslate("artist", ".galleryViewTable .thumb_square > a:nth-child(4)", {
        classes: "inline",
    });

    // Profile tab https://www.hentai-foundry.com/user/DrGraevling/profile
    findAndTranslate("artist", ".breadcrumbs a:contains('Users') + span", {
        toProfileUrl: () => window.location.href,
        tagPosition: TAG_POSITIONS.beforeend,
        classes: "inline",
    });

    // Orher tabs https://www.hentai-foundry.com/pictures/user/DrGraevling
    findAndTranslate("artist", ".breadcrumbs a[href^='/user/']", {
        classes: "inline",
    });
}

function initializeTwitter () {
    GM_addStyle(`
        .ex-artist-tag {
            font-family: system-ui, -apple-system, BlinkMacSystemFont,
                "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif;
        }
        /* Old design: on post page locate the artist tag below author's @name. */
        .permalink-header {
            display: grid;
            grid-template-columns: 1fr auto auto;
            height: auto;
        }
        .permalink-header .ex-artist-tag {
            grid-row: 2;
            margin-left: 0;
        }
        /* Fix position of artist tag in an expanded tweet */
        .r-18u37iz.r-thb0q2.r-wgs6xk .r-zl2h9q {
            display: grid;
            grid-template-columns: auto 32px;
        }
        .r-18u37iz.r-thb0q2.r-wgs6xk .r-zl2h9q .ex-artist-tag {
            grid-area: 2/1;
            margin: 0;
        }
    `);

    // Old dedsign
    if ($("body > div#doc").length > 0) {
        findAndTranslate("tag", ".twitter-hashtag", {
            asyncMode: true,
            toTagName: getNormalizedHashtagName,
        });

        // Header card
        findAndTranslate("artist", ".ProfileHeaderCard-screennameLink", {
            asyncMode: true,
        });

        // Popuping user card info
        findAndTranslate("artist", ".ProfileCard-screennameLink", {
            asyncMode: true,
        });

        // Tweet authors and comments
        findAndTranslate("artist", "a.js-user-profile-link", {
            predicate: ":not(.js-retweet-text) > a",
            classes: "inline",
            asyncMode: true,
        });

        // Quoted tweets https://twitter.com/Murata_Range/status/1108340994557140997
        findAndTranslate("artist", ".username", {
            predicate: "div.js-user-profile-link .username",
            toProfileUrl: (el) => `https://twitter.com/${$(el).find("b").text()}`,
            asyncMode: true,
            classes: "inline",
        });

        return;
    }

    // New design
    // Tags https://twitter.com/mugosatomi/status/1173231575959363584
    findAndTranslate("tag", "a.r-1n1174f", {
        predicate: "a.r-1n1174f[href^='/hashtag/']",
        asyncMode: true,
        toTagName: getNormalizedHashtagName,
    });

    // Floating name of a channel https://twitter.com/mugosatomi
    const URLfromLocation = () => (
        `https://twitter.com${safeMatch(window.location.pathname, /\/\w+/)}`
    );
    findAndTranslate("artist", "div[data-testid='primaryColumn']>div>:first-child h2>div>div>div", {
        toProfileUrl: URLfromLocation,
        classes: "inline",
        onadded: deleteOnChange("span>span"),
    });
    // Look for (re-)adding of the top bar
    new MutationSummary({
        queries: [{ element: "h2" }],
        callback: ([summary]) => {
            const $h2 = $(summary.added[0]);
            // If it is the top bar
            if (!$h2.is("div[data-testid='primaryColumn']>div>:first-child h2")) {
                return;
            }
            // If now it is channel name
            const $div = $h2.find(">div>div>div");
            if ($div.length > 0) {
                findAndTranslate("artist", $div, {
                    toProfileUrl: URLfromLocation,
                    classes: "inline",
                    onadded: deleteOnChange("span>span"),
                });
            }
            // Look for text changes of the top bar
            new MutationSummary({
                rootNode: $h2[0],
                queries: [{ characterData: true }],
                callback: () => {
                    const $div2 = $h2.find(">div>div>div");
                    // Return if it already translated, to avoid self-triggering
                    if ($div2.next(TAG_SELECTOR).length > 0) {
                        return;
                    }
                    findAndTranslate("artist", $div2, {
                        toProfileUrl: URLfromLocation,
                        classes: "inline",
                        onadded: deleteOnChange("span>span"),
                    });
                },
            });
        },
    });

    // Tweet, expanded tweet and comment authors
    // https://twitter.com/mugosatomi/status/1173231575959363584
    findAndTranslate("artist", "div.r-1wbh5a2.r-dnmrzs", {
        predicate: "div[data-testid='primaryColumn'] article div:has(>a.r-1wbh5a2)",
        toProfileUrl: linkInChildren,
        classes: "inline",
        asyncMode: true,
    });

    // Quoted tweets https://twitter.com/Murata_Range/status/1108340994557140997
    findAndTranslate("artist", "div.r-1wbh5a2.r-1udh08x", {
        toProfileUrl: (el) => `https://twitter.com/${
            $(el)
                .find(".r-1f6r7vd")
                .text()
                .slice(1)
        }`,
        classes: "inline",
        asyncMode: true,
    });

    // User card info
    findAndTranslate("artist", "a", {
        predicate: "div.r-1g94qm0 > a",
        tagPosition: TAG_POSITIONS.beforeend,
        asyncMode: true,
    });
}

function initializeArtStation () {
    GM_addStyle(`
        .qtip-content {
            box-sizing: initial;
        }
        .artist-name-and-headline .ex-artist-tag {
            font-size: 12pt;
            line-height: 150%;
        }
        .hover-card .ex-artist-tag {
            font-size: 12pt;
            margin-top: -10px;
        }
        a.user .ex-artist-tag {
            line-height: 100%;
        }
        .site-title .ex-artist-tag {
            font-size: 12pt;
            line-height: 100%;
            margin-top: -10px;
        }
        .site-title .ex-artist-tag a {
            font-size: 12pt;
        }
    `);

    const getArtistName = (ref) => {
        if (!ref) return "";
        if (ref.startsWith("/")) {
            const word = ref.match(/[a-z0-9_-]+/i);
            if (word) return word[0];
        } else if (ref.startsWith("https://www")) {
            const word = ref.match(/artstation\.com\/([a-z0-9_-]+)/i);
            if (word) return word[1];
        } else if (ref.startsWith("https://")) {
            const word = ref.match(/\/\/([a-z0-9_-]+)\.artstation\.com/i);
            if (word) return word[1];
        }
        return "";
    };

    function toFullURL (url) {
        if (url && typeof url !== "string") {
            // eslint-disable-next-line no-param-reassign
            url = (url[0] || url).getAttribute("href");
        }

        let artistName = getArtistName(url) || getArtistName(window.location.href);
        if (artistName === "artwork") artistName = "";
        if (!artistName) {
            return "";
        }

        return `https://www.artstation.com/${artistName}`;
    }

    function hasValidHref (el) {
        const href = el.getAttribute("href");
        return href && (href.startsWith("http") || href.startsWith("/") && href.length > 1);
    }

    // https://www.artstation.com/jubi
    // https://www.artstation.com/jubi/*
    findAndTranslate("artist", "h1.artist-name", {
        toProfileUrl: toFullURL,
        asyncMode: true,
    });

    // https://www.artstation.com/artwork/0X40zG
    findAndTranslate("artist", "a[hover-card]", {
        requiredAttributes: "href",
        predicate: (el) => el.matches(".name > a") && hasValidHref(el),
        toProfileUrl: toFullURL,
        asyncMode: true,
    });

    findAndTranslate("tag", ".label-tag", {
        tagPosition: TAG_POSITIONS.beforeend,
        asyncMode: true,
    });

    // Hover card
    findAndTranslate("artist", "a", {
        requiredAttributes: "href",
        predicate: (el) => el.matches(".hover-card-name > a") && hasValidHref(el),
        asyncMode: true,
    });

    // https://www.artstation.com/jubi/following
    // https://www.artstation.com/jubi/followers
    findAndTranslate("artist", ".users-grid-name", {
        toProfileUrl: (el) => toFullURL($(el).find("a")),
        asyncMode: true,
    });

    // Default personal websites:
    // https://jubi.artstation.com/
    // https://anninosart.artstation.com/
    // Customized personal websites:
    // https://inawong.artstation.com/
    // https://kastep.artstation.com/
    // https://tinadraw.artstation.com/
    // https://dylan-kowalski.artstation.com/
    findAndTranslate("artist", ".site-title a", {
        toProfileUrl: toFullURL,
    });
}

function initializeSauceNAO () {
    GM_addStyle(`
        .ex-translated-tags {
            margin: 0;
        }
        .ex-translated-tags::before, .ex-translated-tags::after {
            content: none;
        }
        .ex-translated-tags + .target, .ex-artist-tag + .target {
            display: none;
        }
    `);

    $(".resulttitle, .resultcontentcolumn")
        .contents()
        .filter((i, el) => el.nodeType === 3) // Get text nodes
        .wrap("<span class=target>");
    $(".target:contains(', ')").replaceWith((i, html) => (
        html
            .split(", ")
            .map((str) => `<span class="target">${str}</span>`)
            .join(", ")
    ));

    // http://saucenao.com/search.php?db=999&url=https%3A%2F%2Fraikou4.donmai.us%2Fpreview%2F5e%2F8e%2F5e8e7a03c49906aaad157de8aeb188e4.jpg
    // http://saucenao.com/search.php?db=999&url=https%3A%2F%2Fraikou4.donmai.us%2Fpreview%2Fad%2F90%2Fad90ad1cc3407f03955f22b427d21707.jpg
    findAndTranslate("artist", "strong:contains('Member: ')+a, strong:contains('Author: ')+a", {
        toProfileUrl: (el) => {
            const { href } = el;
            // New fix of #18
            // Blacklisting of Medibang because search is wrong
            // and returns all 10 artist with links to Medibang
            // e.g. https://saucenao.com/search.php?db=999&url=http%3A%2F%2Fmedibangpaint.com%2Fwp-content%2Fuploads%2F2015%2F05%2Fgallerylist-04.jpg
            if (href.startsWith("https://medibang.com/")) {
                return "";
            }
            return href;
        },
        classes: "inline",
    });

    findAndTranslate("artistByName", ".resulttitle .target", {
        tagPosition: TAG_POSITIONS.beforebegin,
        classes: "inline",
    });

    findAndTranslate("tag", ".resultcontentcolumn .target", {
        tagPosition: TAG_POSITIONS.beforebegin,
    });
}

function initializePawoo () {
    GM_addStyle(`
        .ex-artist-tag {
            line-height: 100%;
        }
        /* Active Users sidebar */
        .account__avatar-wrapper {
            display: flex;
            height: 100%;
            align-items: center;
        }
        /* fix newline in arist tag in cards of following users and followers */
        .ex-artist-tag a {
            display: inline !important;
        }
    `);

    // https://pawoo.net/@yamadorikodi
    // artist name in channel header
    findAndTranslate("artist", ".name small", {
        toProfileUrl: (el) => `https://pawoo.net/@${safeMatch(el.textContent, /[^@]+/)}`,
        tagPosition: TAG_POSITIONS.afterbegin,
    });

    // Post author, commentor
    findAndTranslate("artist", "a.status__display-name span span", {
        classes: "inline",
        toProfileUrl: (el) => {
            const url = $(el).closest("a").prop("href");
            // Pawoo can include reposted messages from other mastodon-based sites
            if (url.startsWith("https://pawoo.net/@")) return url;
            return "";
        },
    });

    // Expanded post author
    // https://pawoo.net/@mayumani/102910946688187767
    findAndTranslate("artist", "a.detailed-status__display-name span strong", {
        classes: "inline",
        tagPosition: TAG_POSITIONS.beforeend,
    });

    // Users in sidebar
    findAndTranslate("artist", "a.account__display-name span span");

    // Cards of following users and followers
    findAndTranslate("artist", ".account-grid-card .name a");

    // Tags https://pawoo.net/@SilSinn9801
    findAndTranslate("tag", ".hashtag");
}

function initializeTweetDeck () {
    // https://tweetdeck.twitter.com/

    findAndTranslate("tag", "span.link-complex-target", {
        predicate: "a[rel='hashtag'] span.link-complex-target",
        asyncMode: true,
        toTagName: getNormalizedHashtagName,
    });

    // User card info
    findAndTranslate("artist", "p.username", {
        asyncMode: true,
    });

    // Tweet authors and comments
    findAndTranslate("artist", "a.account-link", {
        predicate: "a:has(.username)",
        asyncMode: true,
    });
}

function initializePixivFanbox () {
    // https://www.pixiv.net/fanbox/creator/310631
    // channel header
    findAndTranslate("artist", "a", {
        predicate: "h1 a[href^='/fanbox/creator/']",
        classes: "inline",
        asyncMode: true,
    });

    // Post author
    findAndTranslate("artist", "div.sc-7161tb-4", {
        toProfileUrl: (el) => ($(el).closest("a").prop("href") || "").replace(/\/post\/\d+/, ""),
        tagPosition: TAG_POSITIONS.beforeend,
        classes: "inline",
        asyncMode: true,
    });
}

function initializeQtipContainer () {
    // Container and viewport for qTips
    const $div = $(`<div id="ex-qtips"></div>`).appendTo("body");
    ARTIST_QTIP_SETTINGS.position.viewport = $div;
    ARTIST_QTIP_SETTINGS.position.container = $div;
}

function initialize () {
    initializeQtipContainer();
    GM_jQuery_setup();
    GM_addStyle(PROGRAM_CSS);
    GM_addStyle(GM_getResourceText("jquery_qtip_css"));
    GM_registerMenuCommand("Settings", showSettings, "S");
    // So that JSON stringify can be used to generate memoize keys
    /* eslint-disable no-extend-native */
    RegExp.prototype.toJSON = RegExp.prototype.toString;
    /* eslint-enable no-extend-native */

    switch (window.location.host) {
        case "www.pixiv.net":
            if (window.location.pathname.startsWith("/fanbox")) {
                initializePixivFanbox();
            } else {
                initializePixiv();
            }
            break;
        case "dic.pixiv.net":          initializePixiv();         break;
        case "nijie.info":             initializeNijie();         break;
        case "seiga.nicovideo.jp":     initializeNicoSeiga();     break;
        case "www.tinami.com":         initializeTinami();        break;
        case "bcy.net":                initializeBCY();           break;
        case "www.hentai-foundry.com": initializeHentaiFoundry(); break;
        case "twitter.com":            initializeTwitter();       break;
        case "tweetdeck.twitter.com":  initializeTweetDeck();     break;
        case "saucenao.com":           initializeSauceNAO();      break;
        case "pawoo.net":              initializePawoo();         break;
        case "www.deviantart.com":     initializeDeviantArt();    break;
        case "www.artstation.com":     initializeArtStation();    break;
        default:
            if (window.location.host.match(/artstation\.com/)) {
                initializeArtStation();
            }
    }
}

//------------------------
// Program execution start
//------------------------

initialize();
