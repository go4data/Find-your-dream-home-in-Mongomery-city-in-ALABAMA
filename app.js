/* ============================================================
   RealEstate AI — Core Application Logic
   ============================================================ */

(function () {
    'use strict';

    // ===================== STATE =====================
    let allProperties = [];
    let lastResults = [];
    let currentQuery = '';
    const MAX_RESULTS = 7; // Show only the top 7 most relevant results

    const LISTINGS_KEY = 'realestate_user_listings';

    // File upload state
    let uploadedImages = [];   // Array of { file, dataUrl }
    let uploadedVideo = null;  // { file, dataUrl }

    // ===================== DOM REFS =====================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ===================== INIT =====================
    document.addEventListener('DOMContentLoaded', async () => {
        await loadProperties();
        initNavigation();
        initChat();
        initOwnerForm();
        initFileUploads();
        initSettings();
        initCrawlRunner();
        initScrollAnimations();
        renderMyListings();
    });

    // ===================== DATA LAYER =====================
    async function loadProperties() {
        try {
            const resp = await fetch('properties.json');
            if (!resp.ok) throw new Error('Failed to load properties.json');
            allProperties = await resp.json();
            // Merge user listings
            const userListings = getUserListings();
            allProperties = allProperties.concat(userListings);
            console.info(`[Data] Loaded ${allProperties.length} properties.`);
        } catch (err) {
            console.error('[Data] Error loading properties:', err);
            showToast('Failed to load property data. Please refresh.', 'error');
        }
    }

    function getUserListings() {
        try {
            const stored = localStorage.getItem(LISTINGS_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch { return []; }
    }

    function saveUserListing(listing) {
        const listings = getUserListings();
        listing.id = Date.now();
        listing.userListed = true;
        listings.push(listing);
        localStorage.setItem(LISTINGS_KEY, JSON.stringify(listings));
        allProperties.push(listing);
        return listing;
    }

    function clearUserListings() {
        localStorage.removeItem(LISTINGS_KEY);
        allProperties = allProperties.filter(p => !p.userListed);
    }

    // ===================== SEARCH ENGINE =====================
    function searchProperties(query) {
        if (!query || !query.trim()) return [];

        const q = query.toLowerCase();
        const parsed = parseQuery(q);

        // STRICT FILTERING: pre-filter by hard constraints before scoring
        let candidates = [...allProperties];

        // Hard filter 1: If user specified rent/sale, EXCLUDE wrong type
        if (parsed.type) {
            candidates = candidates.filter(prop => {
                const purpose = (prop.property_purpose || '').toLowerCase();
                if (parsed.type === 'rent') return purpose.includes('rent') || prop.type === 'rent';
                if (parsed.type === 'sale') return purpose.includes('sale') || prop.type === 'sale';
                return true;
            });
        }

        // Hard filter 2: If user specified max price, exclude properties > 130% of max
        if (parsed.maxPrice) {
            candidates = candidates.filter(prop => {
                const price = parseFloat(prop.price) || 0;
                return price <= parsed.maxPrice * 1.3;
            });
        }

        // Hard filter 3: If user specified beds, exclude properties off by > 1
        if (parsed.beds !== null) {
            candidates = candidates.filter(prop => {
                const beds = parseFloat(prop.beds) || 0;
                return Math.abs(beds - parsed.beds) <= 1;
            });
        }

        // Score remaining candidates
        const scored = candidates.map(prop => {
            let score = 0;
            let maxScore = 0;

            // --- Type match (rent/sale) ---
            maxScore += 25;
            const purpose = (prop.property_purpose || '').toLowerCase();
            if (parsed.type) {
                if (parsed.type === 'rent' && (purpose.includes('rent') || prop.type === 'rent')) score += 25;
                else if (parsed.type === 'sale' && (purpose.includes('sale') || prop.type === 'sale')) score += 25;
                // wrong type: score stays 0 (but shouldn't reach here due to hard filter)
            } else {
                score += 15;
            }

            // --- Price match (strict) ---
            maxScore += 30;
            const price = parseFloat(prop.price) || 0;
            if (parsed.maxPrice && parsed.minPrice) {
                if (price >= parsed.minPrice && price <= parsed.maxPrice) score += 30;
                else if (price <= parsed.maxPrice * 1.1) score += 18;
                else score += 5;
            } else if (parsed.maxPrice) {
                if (price <= parsed.maxPrice) score += 30;
                else if (price <= parsed.maxPrice * 1.15) score += 15;
                else score += 3;
            } else if (parsed.minPrice) {
                if (price >= parsed.minPrice) score += 25;
            } else {
                score += 12;
            }

            // --- Beds match (strict) ---
            maxScore += 25;
            const beds = parseFloat(prop.beds) || 0;
            if (parsed.beds !== null) {
                if (beds === parsed.beds) score += 25;
                else if (Math.abs(beds - parsed.beds) <= 1) score += 10;
            } else {
                score += 10;
            }

            // --- Baths match ---
            maxScore += 10;
            const baths = parseFloat(prop.bathrooms) || 0;
            if (parsed.baths !== null) {
                if (baths >= parsed.baths) score += 10;
                else if (Math.abs(baths - parsed.baths) <= 0.5) score += 6;
            } else {
                score += 5;
            }

            // --- Area match ---
            maxScore += 5;
            const area = parseFloat(prop.area_sqft) || 0;
            if (parsed.minArea) {
                if (area >= parsed.minArea) score += 5;
                else if (area >= parsed.minArea * 0.8) score += 2;
            } else {
                score += 3;
            }

            // --- Address / keyword match ---
            maxScore += 5;
            const address = (prop.address || '').toLowerCase();
            if (parsed.keywords.length > 0) {
                const matchCount = parsed.keywords.filter(kw => address.includes(kw) || purpose.includes(kw)).length;
                score += Math.min(5, (matchCount / parsed.keywords.length) * 5);
            } else {
                score += 3;
            }

            const matchPct = Math.round((score / maxScore) * 100);
            return { ...prop, matchScore: matchPct };
        });

        // Require at least 60% match, sort descending, limit to top MAX_RESULTS
        return scored
            .filter(p => p.matchScore >= 60)
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, MAX_RESULTS);
    }

    function parseQuery(q) {
        const result = {
            type: null,      // 'rent' or 'sale'
            maxPrice: null,
            minPrice: null,
            beds: null,
            baths: null,
            minArea: null,
            keywords: []
        };

        // Type
        if (/\brent\b|for\s*rent\b|\brenting\b/.test(q)) result.type = 'rent';
        else if (/\bsale\b|for\s*sale\b|\bbuy\b|\bbuying\b|\bpurchase\b/.test(q)) result.type = 'sale';

        // Price parsing
        const priceUnder = q.match(/(?:under|below|less\s*than|max|at\s*most|up\s*to|budget)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m)?/i);
        if (priceUnder) {
            result.maxPrice = parseNumericValue(priceUnder[1], priceUnder[2]);
        }
        const priceOver = q.match(/(?:over|above|more\s*than|min|at\s*least|from)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m)?/i);
        if (priceOver) {
            result.minPrice = parseNumericValue(priceOver[1], priceOver[2]);
        }
        // "around $X" → ±20%
        const priceAround = q.match(/(?:around|about|near|approximately|~)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m)?/i);
        if (priceAround) {
            const val = parseNumericValue(priceAround[1], priceAround[2]);
            result.minPrice = val * 0.8;
            result.maxPrice = val * 1.2;
        }
        // Bare "$200,000" → treat as max
        if (!result.maxPrice && !result.minPrice) {
            const barePrice = q.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m)?/i);
            if (barePrice) {
                result.maxPrice = parseNumericValue(barePrice[1], barePrice[2]);
            }
        }

        // Beds
        const bedsMatch = q.match(/(\d+)\s*(?:bed|bedroom|bd|br)\b/i);
        if (bedsMatch) result.beds = parseInt(bedsMatch[1]);

        // Baths
        const bathsMatch = q.match(/([\d.]+)\s*(?:bath|bathroom|ba)\b/i);
        if (bathsMatch) result.baths = parseFloat(bathsMatch[1]);

        // Area
        const areaMatch = q.match(/([\d,]+)\s*(?:sq\s*ft|sqft|square\s*feet|sf)\b/i);
        if (areaMatch) result.minArea = parseInt(areaMatch[1].replace(/,/g, ''));

        // Keywords (remaining meaningful words)
        const stopwords = new Set(['i', 'a', 'an', 'the', 'in', 'on', 'at', 'for', 'with', 'and', 'or', 'want', 'need', 'looking', 'find', 'me', 'my', 'to', 'of', 'is', 'am', 'that', 'this', 'it', 'be', 'have', 'do', 'under', 'over', 'below', 'above', 'less', 'more', 'than', 'around', 'about', 'near', 'up', 'from', 'can', 'you', 'please', 'show', 'get', 'search', 'house', 'apartment', 'condo', 'townhome', 'home', 'property', 'place', 'bed', 'bedroom', 'bath', 'bathroom', 'beds', 'baths', 'bedrooms', 'bathrooms', 'sqft', 'rent', 'sale', 'buy', 'price', 'budget', 'cheap', 'affordable', 'large', 'small', 'big']);
        const words = q.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
        // Keep location-related keywords
        const locationKeywords = words.filter(w => !['thousand', 'million', 'hundred'].includes(w));
        result.keywords = locationKeywords;

        return result;
    }

    function parseNumericValue(numStr, suffix) {
        let val = parseFloat(numStr.replace(/,/g, ''));
        if (suffix) {
            const s = suffix.toLowerCase();
            if (s === 'k' || s === 'thousand') val *= 1000;
            else if (s === 'm' || s === 'million') val *= 1000000;
        }
        // Auto-detection: if value seems too small for real estate (e.g., "200" likely means $200,000)
        if (val > 0 && val < 500 && !suffix) {
            // Ambiguous — could be $200 rent or $200k sale. Leave as-is.
        }
        return val;
    }

    // ===================== CHAT UI =====================
    function initChat() {
        const form = $('#chatForm');
        const input = $('#chatInput');

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const query = input.value.trim();
            if (!query) return;
            handleChatQuery(query);
            input.value = '';
        });

        // Suggestion chips
        $$('.suggestion-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const query = chip.dataset.query;
                input.value = query;
                handleChatQuery(query);
                input.value = '';
            });
        });

        // Sort change
        $('#resultsSort').addEventListener('change', () => sortAndRenderResults());

        // Back to chat
        $('#backToChat').addEventListener('click', () => {
            $('#resultsContainer').style.display = 'none';
            $('.chat-container').style.display = '';
        });
    }

    function handleChatQuery(query) {
        currentQuery = query;
        addMessage(query, 'user');

        // Show thinking
        const thinkingEl = addMessage('<div class="spinner"></div> Searching properties...', 'bot', true);

        setTimeout(() => {
            const results = searchProperties(query);
            lastResults = results;

            // Remove thinking
            thinkingEl.remove();

            if (results.length === 0) {
                addMessage("I couldn't find any properties matching your criteria closely enough. Try adjusting — maybe widen the price range, change bedrooms, or switch between rent/sale.", 'bot');
            } else {
                const top = results.slice(0, 3);
                const summary = `Here are the **top ${results.length} best-matched** properties:\n\n` +
                    top.map((p, i) => `${i + 1}. **${p.matchScore}% match** — $${formatPrice(p.price)} | ${p.beds || '?'} bed, ${p.bathrooms || '?'} bath | ${truncate(p.address, 40)}`).join('\n') +
                    (results.length > 3 ? `\n\n_+ ${results.length - 3} more below..._` : '');
                addMessage(summary, 'bot');

                // Show results grid
                renderResults(results);
                $('.chat-container').style.display = 'none';
                $('#resultsContainer').style.display = '';
                $('#resultsTitle').textContent = `Top ${results.length} Matches`;
            }
        }, 600);
    }

    function addMessage(content, sender, isHTML = false) {
        const messages = $('#chatMessages');
        const msg = document.createElement('div');
        msg.className = `chat-message ${sender}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = sender === 'user' ? '🧑' : '🤖';

        const body = document.createElement('div');
        body.className = 'message-content';
        if (isHTML) body.innerHTML = content;
        else body.innerHTML = markdownToHTML(content);

        msg.appendChild(avatar);
        msg.appendChild(body);
        messages.appendChild(msg);
        messages.scrollTop = messages.scrollHeight;
        return msg;
    }

    // ===================== RESULTS RENDERING =====================
    function renderResults(results) {
        const grid = $('#resultsGrid');
        grid.innerHTML = '';
        const sorted = sortResults(results);
        sorted.forEach((prop, idx) => {
            const card = createPropertyCard(prop, idx);
            grid.appendChild(card);
        });
    }

    function sortAndRenderResults() {
        renderResults(lastResults);
    }

    function sortResults(results) {
        const sortBy = $('#resultsSort').value;
        const sorted = [...results];
        switch (sortBy) {
            case 'price-asc': sorted.sort((a, b) => (a.price || 0) - (b.price || 0)); break;
            case 'price-desc': sorted.sort((a, b) => (b.price || 0) - (a.price || 0)); break;
            case 'area-desc': sorted.sort((a, b) => (b.area_sqft || 0) - (a.area_sqft || 0)); break;
            default: sorted.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
        }
        return sorted;
    }

    function createPropertyCard(prop, idx) {
        const card = document.createElement('div');
        card.className = 'property-card';
        card.style.animationDelay = `${idx * 0.05}s`;

        const img = prop.image_1 || prop.image_2 || prop.image_3 || '';
        const hasVideo = !!(prop.video_url);
        const isRent = (prop.type === 'rent') || (prop.property_purpose || '').toLowerCase().includes('rent');
        const priceLabel = isRent ? '/mo' : '';

        card.innerHTML = `
            <div class="card-media">
                ${img ? `<img src="${escapeHTML(img)}" alt="Property at ${escapeHTML(prop.address || 'Unknown')}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22><rect fill=%22%23111827%22 width=%22400%22 height=%22200%22/><text fill=%22%2364748b%22 x=%22200%22 y=%22105%22 text-anchor=%22middle%22 font-family=%22sans-serif%22 font-size=%2214%22>No Image Available</text></svg>'">` : `<div style="width:100%;height:100%;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.875rem;">No Image</div>`}
                ${prop.matchScore ? `<div class="card-badge-match">${prop.matchScore}% Match</div>` : ''}
                <div class="card-badge-type">${isRent ? 'For Rent' : 'For Sale'}</div>
                ${hasVideo ? '<div class="card-badge-video">▶</div>' : ''}
            </div>
            <div class="card-body">
                <div class="card-price">$${formatPrice(prop.price)}<span>${priceLabel}</span></div>
                <div class="card-address">${escapeHTML(prop.address || 'Montgomery, AL')}</div>
                <div class="card-features">
                    <span class="card-feature"><strong>${prop.beds || '—'}</strong> Beds</span>
                    <span class="card-feature"><strong>${prop.bathrooms || '—'}</strong> Baths</span>
                    <span class="card-feature"><strong>${formatNumber(prop.area_sqft)}</strong> sqft</span>
                </div>
                ${prop.additional_features ? `<div class="card-additional">${escapeHTML(prop.additional_features)}</div>` : ''}
            </div>
        `;

        card.addEventListener('click', () => openPropertyDetail(prop));
        return card;
    }

    // ===================== PROPERTY DETAIL MODAL =====================
    function openPropertyDetail(prop) {
        const detail = $('#propertyDetail');
        const isRent = (prop.type === 'rent') || (prop.property_purpose || '').toLowerCase().includes('rent');
        const priceLabel = isRent ? '/mo' : '';

        // Prepare images
        const images = [prop.image_1, prop.image_2, prop.image_3].filter(Boolean);
        const mainImg = images[0] || '';
        const thumbs = images.slice(1);

        // Prepare embedded YouTube
        let videoHTML = '';
        if (prop.video_url) {
            const embedUrl = youtubeToEmbed(prop.video_url);
            if (embedUrl) {
                videoHTML = `<div class="detail-video"><iframe src="${embedUrl}" title="Property Video Tour" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
            }
        }

        // Build Google Maps embed URL from address
        const mapAddress = encodeURIComponent(prop.address || 'Montgomery, AL');
        const mapHTML = `<div class="detail-map"><iframe src="https://maps.google.com/maps?q=${mapAddress}&t=&z=15&ie=UTF8&iwloc=&output=embed" title="Property Location" loading="lazy" allowfullscreen></iframe></div>`;

        detail.innerHTML = `
            <div class="detail-media-section">
                <div class="detail-images">
                    ${mainImg ? `<img class="detail-img-main" src="${escapeHTML(mainImg)}" alt="Property" id="detailMainImg" onerror="this.style.display='none'">` : ''}
                    ${thumbs.length ? `<div class="detail-img-thumbs">${thumbs.map(t => `<img class="detail-img-thumb" src="${escapeHTML(t)}" alt="Property" onclick="document.getElementById('detailMainImg').src=this.src" onerror="this.style.display='none'">`).join('')}</div>` : ''}
                </div>
                ${videoHTML || '<div style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.875rem;border:1px dashed var(--border-glass);border-radius:var(--radius-md);padding:40px;">No video available</div>'}
            </div>
            <div class="detail-info">
                <div class="detail-price">$${formatPrice(prop.price)}<span>${priceLabel}</span></div>
                <div class="detail-address">📍 ${escapeHTML(prop.address || 'Montgomery, AL')}</div>
                ${mapHTML}
                <div class="detail-stats">
                    <div class="detail-stat"><span class="detail-stat-value">${prop.beds || '—'}</span><span class="detail-stat-label">Bedrooms</span></div>
                    <div class="detail-stat"><span class="detail-stat-value">${prop.bathrooms || '—'}</span><span class="detail-stat-label">Bathrooms</span></div>
                    <div class="detail-stat"><span class="detail-stat-value">${formatNumber(prop.area_sqft)}</span><span class="detail-stat-label">Sq Ft</span></div>
                    ${prop.matchScore ? `<div class="detail-stat"><span class="detail-stat-value" style="color:var(--accent-1)">${prop.matchScore}%</span><span class="detail-stat-label">Match</span></div>` : ''}
                </div>
                <div class="detail-meta">
                    <span><strong>Type:</strong> ${escapeHTML(prop.property_purpose || (isRent ? 'For Rent' : 'For Sale'))}</span>
                    <span><strong>Listed by:</strong> ${escapeHTML(prop.posted_by || 'Unknown')}</span>
                    ${prop.additional_features ? `<span><strong>Features:</strong> ${escapeHTML(prop.additional_features)}</span>` : ''}
                </div>
            </div>
        `;

        $('#propertyModal').classList.add('open');
    }

    // ===================== OWNER LISTING FORM =====================
    function initOwnerForm() {
        const form = $('#listingForm');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const purpose = $('#listingPurpose').value;
            const isRent = purpose.toLowerCase().includes('rent');

            // Use uploaded files if available, otherwise fall back to URLs
            const img1 = uploadedImages[0]?.dataUrl || $('#listingImg1').value || null;
            const img2 = uploadedImages[1]?.dataUrl || $('#listingImg2').value || null;
            const img3 = uploadedImages[2]?.dataUrl || $('#listingImg3').value || null;
            const vid = uploadedVideo?.dataUrl || $('#listingVideo').value || null;

            const listing = {
                price: parseFloat($('#listingPrice').value),
                beds: parseFloat($('#listingBeds').value),
                bathrooms: parseFloat($('#listingBaths').value),
                area_sqft: parseFloat($('#listingArea').value),
                address: $('#listingAddress').value,
                property_purpose: purpose,
                posted_by: $('#listingPostedBy').value,
                additional_features: $('#listingFeatures').value || null,
                image_1: img1,
                image_2: img2,
                image_3: img3,
                video_url: vid,
                type: isRent ? 'rent' : 'sale',
                description: $('#listingDescription').value || null
            };

            saveUserListing(listing);
            showToast('Property listed successfully! It is now searchable.', 'success');
            form.reset();
            clearUploads();
            renderMyListings();
        });

        // AI description generator
        $('#generateDescBtn').addEventListener('click', () => {
            const beds = $('#listingBeds').value || '?';
            const baths = $('#listingBaths').value || '?';
            const area = $('#listingArea').value || '?';
            const price = $('#listingPrice').value;
            const purpose = $('#listingPurpose').value || 'property';
            const address = $('#listingAddress').value || 'Montgomery, AL';
            const features = $('#listingFeatures').value || '';

            const desc = generateDescription(purpose, beds, baths, area, price, address, features);
            $('#listingDescription').value = desc;
            showToast('AI description generated!', 'info');
        });
    }

    function generateDescription(purpose, beds, baths, area, price, address, features) {
        const adjectives = ['stunning', 'beautiful', 'charming', 'spacious', 'lovely', 'well-maintained', 'elegant', 'cozy', 'modern', 'impeccable'];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const adj2 = adjectives[Math.floor(Math.random() * adjectives.length)];

        const isRent = purpose.toLowerCase().includes('rent');
        const action = isRent ? 'available for rent' : 'available for purchase';

        let desc = `This ${adj} ${purpose.toLowerCase()} is ${action} at ${address}. `;
        desc += `Featuring ${beds} bedrooms, ${baths} bathrooms, and ${formatNumber(area)} square feet of ${adj2} living space. `;
        if (price) desc += `Priced at $${formatPrice(price)}${isRent ? '/month' : ''}, this property offers exceptional value. `;
        if (features) desc += `Notable features include: ${features}. `;
        desc += `Don't miss this opportunity — schedule a viewing today!`;

        return desc;
    }

    function renderMyListings() {
        const listings = getUserListings();
        const container = $('#myListings');
        const grid = $('#myListingsGrid');

        // Update settings count
        const countEl = $('#settingsListingCount');
        if (countEl) countEl.textContent = listings.length;

        if (listings.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = '';
        grid.innerHTML = '';
        listings.forEach((prop, idx) => {
            const card = createPropertyCard(prop, idx);
            grid.appendChild(card);
        });
    }

    // ===================== FILE UPLOADS =====================
    function initFileUploads() {
        // ----- IMAGE UPLOADS -----
        const imageZone = $('#imageUploadZone');
        const imageInput = $('#imageFileInput');
        const imagePreviews = $('#imagePreviews');

        // Drag events
        ['dragenter', 'dragover'].forEach(evt => {
            imageZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); imageZone.classList.add('drag-over'); });
        });
        ['dragleave', 'drop'].forEach(evt => {
            imageZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); imageZone.classList.remove('drag-over'); });
        });

        imageZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            handleImageFiles(files);
        });

        imageInput.addEventListener('change', () => {
            const files = Array.from(imageInput.files);
            handleImageFiles(files);
            imageInput.value = ''; // reset so same file can be selected again
        });

        // Paste support (works anywhere on the page)
        document.addEventListener('paste', (e) => {
            // Only handle if the owner section is visible in viewport
            const ownerSection = $('#owner');
            const rect = ownerSection.getBoundingClientRect();
            if (rect.top > window.innerHeight || rect.bottom < 0) return;

            const items = Array.from(e.clipboardData?.items || []);
            const imageItems = items.filter(i => i.type.startsWith('image/'));
            const files = imageItems.map(i => i.getAsFile()).filter(Boolean);
            if (files.length > 0) {
                e.preventDefault();
                handleImageFiles(files);
            }
        });

        // ----- VIDEO UPLOAD -----
        const videoZone = $('#videoUploadZone');
        const videoInput = $('#videoFileInput');

        ['dragenter', 'dragover'].forEach(evt => {
            videoZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); videoZone.classList.add('drag-over'); });
        });
        ['dragleave', 'drop'].forEach(evt => {
            videoZone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); videoZone.classList.remove('drag-over'); });
        });

        videoZone.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
            if (files.length > 0) handleVideoFile(files[0]);
        });

        videoInput.addEventListener('change', () => {
            if (videoInput.files[0]) handleVideoFile(videoInput.files[0]);
            videoInput.value = '';
        });
    }

    function handleImageFiles(files) {
        const remaining = 3 - uploadedImages.length;
        if (remaining <= 0) {
            showToast('Maximum 3 images allowed.', 'error');
            return;
        }
        const toAdd = files.slice(0, remaining);
        toAdd.forEach(file => {
            const reader = new FileReader();
            reader.onload = () => {
                uploadedImages.push({ file, dataUrl: reader.result });
                renderImagePreviews();
            };
            reader.readAsDataURL(file);
        });
        if (files.length > remaining) {
            showToast(`Only ${remaining} more image(s) allowed. Extra files ignored.`, 'info');
        }
    }

    function renderImagePreviews() {
        const container = $('#imagePreviews');
        container.innerHTML = '';
        uploadedImages.forEach((item, idx) => {
            const preview = document.createElement('div');
            preview.className = 'upload-preview';
            preview.innerHTML = `
                <img src="${item.dataUrl}" alt="Upload ${idx + 1}">
                <button class="upload-preview-remove" title="Remove">&times;</button>
            `;
            preview.querySelector('.upload-preview-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                uploadedImages.splice(idx, 1);
                renderImagePreviews();
            });
            container.appendChild(preview);
        });
    }

    function handleVideoFile(file) {
        if (file.size > 100 * 1024 * 1024) {
            showToast('Video file is too large (max 100MB).', 'error');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            uploadedVideo = { file, dataUrl: reader.result };
            renderVideoPreviews();
            showToast('Video uploaded!', 'success');
        };
        reader.readAsDataURL(file);
    }

    function renderVideoPreviews() {
        const container = $('#videoPreviews');
        container.innerHTML = '';
        if (!uploadedVideo) return;
        const preview = document.createElement('div');
        preview.className = 'upload-preview';
        preview.style.width = '160px';
        preview.innerHTML = `
            <video src="${uploadedVideo.dataUrl}" muted></video>
            <button class="upload-preview-remove" title="Remove">&times;</button>
        `;
        preview.querySelector('.upload-preview-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            uploadedVideo = null;
            renderVideoPreviews();
        });
        container.appendChild(preview);
    }

    function clearUploads() {
        uploadedImages = [];
        uploadedVideo = null;
        const imgPreviews = $('#imagePreviews');
        const vidPreviews = $('#videoPreviews');
        if (imgPreviews) imgPreviews.innerHTML = '';
        if (vidPreviews) vidPreviews.innerHTML = '';
    }

    // ===================== SETTINGS MODAL =====================
    function initSettings() {
        const modal = $('#settingsModal');
        const openBtn = $('#settingsBtn');
        const closeBtn = $('#settingsClose');

        openBtn.addEventListener('click', () => {
            loadSettingsUI();
            modal.classList.add('open');
        });
        closeBtn.addEventListener('click', () => modal.classList.remove('open'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

        // Property modal close
        const propModal = $('#propertyModal');
        const propClose = $('#propertyClose');
        propClose.addEventListener('click', () => propModal.classList.remove('open'));
        propModal.addEventListener('click', (e) => { if (e.target === propModal) propModal.classList.remove('open'); });

        // Tabs
        $$('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.tab-btn').forEach(b => b.classList.remove('active'));
                $$('.tab-panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                $(`#tab-${btn.dataset.tab}`).classList.add('active');
            });
        });

        // Bright Data settings
        $('#bdSaveBtn').addEventListener('click', saveBrightDataSettings);
        $('#bdTestBtn').addEventListener('click', testBrightDataConnection);
        $('#bdClearBtn').addEventListener('click', clearBrightDataKey);
        $('#bdToggleKey').addEventListener('click', () => {
            const input = $('#bdApiKey');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // General settings
        $('#clearListingsBtn').addEventListener('click', () => {
            if (confirm('Clear all your listed properties?')) {
                clearUserListings();
                renderMyListings();
                showToast('All listings cleared.', 'info');
            }
        });

        // Escape key closes modals
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                modal.classList.remove('open');
                propModal.classList.remove('open');
            }
        });
    }

    function loadSettingsUI() {
        const cfg = BrightData.getConfig();
        $('#bdApiKey').value = cfg.apiKey || '';
        $('#bdDatasetId').value = cfg.datasetId || '';
        $('#bdOutputFields').value = cfg.outputFields || 'markdown|html';
        $('#bdIncludeErrors').checked = cfg.includeErrors !== false;
        $('#bdDownloadFormat').value = cfg.downloadFormat || 'json';
        $('#bdCompress').checked = !!cfg.compress;
        if (cfg.batchSize) $('#bdBatchSize').value = cfg.batchSize;
        $('#bdTestResult').textContent = '';
        $('#bdTestResult').className = 'bd-test-result';

        // General
        renderMyListings();
    }

    function saveBrightDataSettings() {
        const config = {
            apiKey: $('#bdApiKey').value.trim(),
            datasetId: $('#bdDatasetId').value.trim(),
            outputFields: $('#bdOutputFields').value.trim(),
            includeErrors: $('#bdIncludeErrors').checked,
            downloadFormat: $('#bdDownloadFormat').value,
            compress: $('#bdCompress').checked,
            batchSize: parseInt($('#bdBatchSize').value) || null
        };
        BrightData.saveConfig(config);
        updateCrawlStatus();
        showToast('Bright Data settings saved!', 'success');
    }

    async function testBrightDataConnection() {
        const result$ = $('#bdTestResult');
        result$.textContent = 'Testing...';
        result$.className = 'bd-test-result';

        // Save first so the test uses current inputs
        saveBrightDataSettings();

        const result = await BrightData.testConnection();
        result$.textContent = result.message;
        result$.className = `bd-test-result ${result.ok ? 'success' : 'error'}`;
    }

    function clearBrightDataKey() {
        BrightData.clearConfig();
        loadSettingsUI();
        updateCrawlStatus();
        showToast('Bright Data key cleared.', 'info');
    }

    // ===================== CRAWL RUNNER =====================
    let crawlSnapshotId = null;

    function initCrawlRunner() {
        $('#runCrawlBtn').addEventListener('click', runCrawl);
        $('#cancelCrawlBtn').addEventListener('click', cancelCrawl);
        $('#viewSnapshotsBtn').addEventListener('click', viewSnapshots);
        updateCrawlStatus();
    }

    function updateCrawlStatus() {
        const indicator = $('#crawlStatusIndicator');
        const text = $('#crawlStatusText');
        if (BrightData.hasApiKey()) {
            indicator.className = 'crawl-status-indicator active';
            text.textContent = 'Connected — Ready to crawl.';
        } else {
            indicator.className = 'crawl-status-indicator';
            text.textContent = 'Demo Mode — Configure your API key in Settings to enable live crawling.';
        }
        updateDiagnostics();
    }

    async function runCrawl() {
        const urlsText = $('#crawlUrls').value.trim();
        if (!urlsText) {
            showToast('Enter at least one URL to crawl.', 'error');
            return;
        }
        const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);

        $('#runCrawlBtn').disabled = true;
        $('#cancelCrawlBtn').disabled = false;
        $('#crawlProgress').style.display = '';
        $('#crawlOutput').style.display = 'none';
        $('#crawlProgressBar').style.width = '10%';
        $('#crawlProgressLabel').textContent = 'Triggering crawl...';

        const triggerResult = await BrightData.triggerCrawl(urls);
        updateDiagnostics();

        if (triggerResult.demo) {
            // Demo mode — simulate progress
            await simulateDemoCrawl(urls);
            return;
        }

        if (!triggerResult.ok) {
            showToast(`Crawl failed: ${triggerResult.message || 'Unknown error'}`, 'error');
            resetCrawlUI();
            return;
        }

        crawlSnapshotId = triggerResult.data.snapshot_id;
        $('#crawlProgressLabel').textContent = `Snapshot: ${crawlSnapshotId} — Polling...`;
        $('#crawlProgressBar').style.width = '30%';

        const finalStatus = await BrightData.pollUntilDone(crawlSnapshotId, (status) => {
            if (status.status === 'running') {
                $('#crawlProgressBar').style.width = '60%';
                $('#crawlProgressLabel').textContent = `Status: running...`;
            }
        });

        updateDiagnostics();

        if (finalStatus.status === 'ready') {
            $('#crawlProgressBar').style.width = '80%';
            $('#crawlProgressLabel').textContent = 'Downloading results...';

            const downloadResult = await BrightData.downloadSnapshot(crawlSnapshotId);
            updateDiagnostics();

            if (downloadResult.ok || downloadResult.data) {
                showCrawlOutput(downloadResult.data);
                $('#crawlProgressBar').style.width = '100%';
                $('#crawlProgressLabel').textContent = 'Complete!';
                showToast('Crawl completed successfully!', 'success');
            } else {
                showToast('Download failed.', 'error');
            }
        } else if (finalStatus.status === 'failed') {
            showToast('Crawl failed. Check diagnostics.', 'error');
        } else if (finalStatus.status === 'cancelled') {
            showToast('Crawl cancelled.', 'info');
        } else {
            showToast('Crawl timed out.', 'error');
        }
        resetCrawlUI();
    }

    async function simulateDemoCrawl(urls) {
        const steps = [
            { pct: 20, text: 'Demo: Triggering crawl...', ms: 500 },
            { pct: 40, text: 'Demo: Crawling in progress...', ms: 800 },
            { pct: 70, text: 'Demo: Processing results...', ms: 600 },
            { pct: 90, text: 'Demo: Downloading snapshot...', ms: 400 },
            { pct: 100, text: 'Demo: Complete!', ms: 300 },
        ];

        for (const step of steps) {
            $('#crawlProgressBar').style.width = step.pct + '%';
            $('#crawlProgressLabel').textContent = step.text;
            await sleep(step.ms);
        }

        const mockData = urls.map(u => ({
            url: u,
            title: `Demo Result for ${new URL(u).hostname}`,
            markdown: `# Demo Crawl Result\n\nThis is a demonstration. Configure your Bright Data API key in Settings to crawl real property data.\n\n**URL:** ${u}`,
            status: 'success'
        }));

        showCrawlOutput(mockData);
        showToast('Demo crawl simulation complete! Add an API key for real data.', 'info');
        resetCrawlUI();
    }

    function showCrawlOutput(data) {
        $('#crawlOutput').style.display = '';
        $('#crawlOutputBody').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

        $('#downloadCrawlBtn').onclick = () => {
            const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `crawl_${crawlSnapshotId || 'demo'}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };
    }

    function cancelCrawl() {
        BrightData.cancelPolling();
        if (crawlSnapshotId && BrightData.hasApiKey()) {
            BrightData.cancelSnapshot(crawlSnapshotId);
        }
        showToast('Crawl cancelled.', 'info');
        resetCrawlUI();
    }

    async function viewSnapshots() {
        const result = await BrightData.listSnapshots({ limit: 10 });
        updateDiagnostics();

        if (result.data && Array.isArray(result.data)) {
            showCrawlOutput(result.data);
        } else {
            showCrawlOutput(result.data || { message: result.message });
        }
    }

    function resetCrawlUI() {
        $('#runCrawlBtn').disabled = false;
        $('#cancelCrawlBtn').disabled = true;
        crawlSnapshotId = null;
    }

    function updateDiagnostics() {
        const body = $('#diagnosticsBody');
        const diags = BrightData.getDiagnostics();
        if (diags.length === 0) {
            body.innerHTML = '<p class="diagnostics-empty">No requests recorded yet.</p>';
            return;
        }
        body.innerHTML = diags.map(d =>
            `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border-color);">
                <strong>${d.method}</strong> ${d.endpoint} — <span style="color:${d.status === 'demo' ? '#f59e0b' : d.status === 'error' ? '#ef4444' : 'var(--accent-4)'}">${d.status}</span> (${d.duration})
                ${d.error ? `<br><span style="color:#ef4444;font-size:0.7rem;">${typeof d.error === 'string' ? d.error : JSON.stringify(d.error)}</span>` : ''}
                ${d.message ? `<br><span style="color:var(--text-muted);font-size:0.7rem;">${d.message}</span>` : ''}
                <br><span style="color:var(--text-muted);font-size:0.65rem;">${d.timestamp}</span>
            </div>`
        ).join('');
    }

    // ===================== NAVIGATION =====================
    function initNavigation() {
        // Scroll spy
        const sections = $$('section[id]');
        const navLinks = $$('.nav-link');

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    navLinks.forEach(l => l.classList.remove('active'));
                    const activeLink = $(`.nav-link[href="#${entry.target.id}"]`);
                    if (activeLink) activeLink.classList.add('active');
                }
            });
        }, { threshold: 0.3 });

        sections.forEach(sec => observer.observe(sec));

        // Scroll class on navbar
        window.addEventListener('scroll', () => {
            $('#navbar').classList.toggle('scrolled', window.scrollY > 50);
        });

        // Hamburger
        $('#hamburgerBtn').addEventListener('click', () => {
            $('#navLinks').classList.toggle('open');
        });

        // Close mobile menu on link click
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                $('#navLinks').classList.remove('open');
            });
        });
    }

    // ===================== SCROLL ANIMATIONS =====================
    function initScrollAnimations() {
        const reveals = $$('.section-header, .listing-form, .crawl-runner-container');
        reveals.forEach(el => el.classList.add('reveal'));

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                }
            });
        }, { threshold: 0.1 });

        reveals.forEach(el => observer.observe(el));
    }

    // ===================== UTILITIES =====================
    function showToast(message, type = 'info') {
        const container = $('#toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icons = { success: '✅', error: '❌', info: 'ℹ️' };
        toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${escapeHTML(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    function formatPrice(val) {
        const n = parseFloat(val);
        if (isNaN(n)) return '—';
        return n.toLocaleString('en-US');
    }

    function formatNumber(val) {
        const n = parseFloat(val);
        if (isNaN(n) || n === 0) return '—';
        return n.toLocaleString('en-US');
    }

    function truncate(str, max) {
        if (!str) return '';
        return str.length > max ? str.substring(0, max) + '…' : str;
    }

    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function markdownToHTML(md) {
        if (!md) return '';
        return md
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/_(.+?)_/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
    }

    function youtubeToEmbed(url) {
        if (!url) return null;
        // Handle youtube.com/shorts/ID
        const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
        if (shortsMatch) return `https://www.youtube.com/embed/${shortsMatch[1]}`;
        // Handle youtube.com/watch?v=ID
        const watchMatch = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
        if (watchMatch) return `https://www.youtube.com/embed/${watchMatch[1]}`;
        // Handle youtu.be/ID
        const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
        if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
        return null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Expose globally for inline handlers
    window.showToast = showToast;
})();
