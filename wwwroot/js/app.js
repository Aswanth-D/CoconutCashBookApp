
// ==========================================
// --- UPDATED SUPABASE CONFIGURATION ---
// ==========================================
const SUPABASE_URL = 'https://ocnfbgubhqvyxidlsdir.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_JmfXhemd49Ej1J_bST4dWg_r_BnOzX0';
const STORAGE_KEY = 'coconut-cashbook-data';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

window.storage = {
    async get(key) {
        const note = document.getElementById('save-note');
        try {
            // 1. Fetch live transactions, stakeholders, stock adjustments, and settings in parallel
            const [txRes, traderRes, laborRes, stockRes, settingsRes] = await Promise.all([
                supabaseClient.from('transactions').select('*'),
                (async () => {
                    try { return await supabaseClient.from('traders').select('*'); }
                    catch (e) { return { data: [] }; }
                })(),
                (async () => {
                    try { return await supabaseClient.from('labor').select('*'); }
                    catch (e) { return { data: [] }; }
                })(),
                (async () => {
                    try { return await supabaseClient.from('stock_adjustments').select('*'); }
                    catch (e) { return { data: [] }; }
                })(),
                (async () => {
                    try { return await supabaseClient.from('app_settings').select('*').eq('key', 'openingBalance'); }
                    catch (e) { return { data: [] }; }
                })()
            ]);

            if (txRes.error) throw txRes.error;

            const dbEntries = txRes.data;
            const dbTraders = traderRes.data || [];
            const dbLabor = laborRes.data || [];
            const dbStock = stockRes.data || [];

            if (dbEntries && dbEntries.length > 0) {
                if (note) note.textContent = 'Data synced from Cloud Database.';

                // Map database fields back to application state format
                const mappedEntries = dbEntries.map(tx => ({
                    id: tx.id,
                    date: tx.date,
                    description: tx.description,
                    category: tx.category,
                    type: tx.type,
                    amount: parseFloat(tx.amount),
                    status: tx.status,
                    notes: tx.notes,
                    trader: tx.category === 'Labor Wages' ? tx.labor_id : tx.trader_id,
                    qty: tx.qty !== undefined ? tx.qty : null,
                    rate: tx.rate !== undefined ? tx.rate : null,
                    unit: tx.unit || 'Units',
                    convFactor: tx.conv_factor || 0,
                    stockQty: tx.stock_qty || 0
                }));

                // Standardize and deduplicate by ID to prevent grid duplication
                const uniqueEntriesMap = new Map();
                mappedEntries.forEach(item => {
                    if (item.id) uniqueEntriesMap.set(item.id, item);
                });
                const cleanEntries = Array.from(uniqueEntriesMap.values());

                // Map stock adjustments accurately from database structure
                const mappedStock = dbStock.map(s => ({
                    id: s.id,
                    batchId: s.batch_id,
                    date: s.date,
                    commodity: s.commodity,
                    direction: s.direction,
                    qty: parseFloat(s.qty) || 0,
                    description: s.description
                }));

                const currentLocalState = JSON.parse(localStorage.getItem(key)) || {};

                // Parse opening balance directly from Supabase settings row if present
                let dbOpeningBalance = currentLocalState.openingBalance || 0;
                if (settingsRes && settingsRes.data && settingsRes.data.length > 0) {
                    dbOpeningBalance = parseFloat(settingsRes.data[0].value) || 0;
                }

                state = {
                    openingBalance: dbOpeningBalance,
                    entries: cleanEntries,
                    traders: dbTraders.length > 0 ? dbTraders : (currentLocalState.traders || []),
                    labor: dbLabor.length > 0 ? dbLabor : (currentLocalState.labor || []),
                    stockAdjustments: mappedStock.length > 0 ? mappedStock : (currentLocalState.stockAdjustments || [])
                };
                return { value: JSON.stringify(state) };
            }
            return { value: localStorage.getItem(key) };
        } catch (e) {
            console.error("Database read error:", e);
            if (note) note.textContent = 'Offline. Showing cached local data.';
            return { value: localStorage.getItem(key) };
        }
    },

    async set(key, value) {
        const note = document.getElementById('save-note');
        try {
            localStorage.setItem(key, value);
            if (note) note.textContent = 'Syncing updates...';

            const parsedState = JSON.parse(value);
            const isValidUUID = (id) => {
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                return uuidRegex.test(id);
            };

            // --- 1. HANDLE TRANSACTIONS SYNC & DELETIONS ---
            const dbTransactions = parsedState.entries.map(e => {
                const isLabor = e.category === 'Labor Wages';
                let rawStakeholderId = e.trader || null;

                let cleanTraderId = !isLabor && isValidUUID(rawStakeholderId) ? rawStakeholderId : null;
                let cleanLaborId = isLabor && isValidUUID(rawStakeholderId) ? rawStakeholderId : null;

                if (!isValidUUID(e.id)) {
                    e.id = uid();
                }

                return {
                    id: e.id,
                    date: e.date,
                    description: e.description || '',
                    category: e.category,
                    type: e.type,
                    amount: parseFloat(e.amount) || 0,
                    trader_id: cleanTraderId,
                    labor_id: cleanLaborId,
                    status: e.status || 'Paid',
                    notes: e.notes || '',
                    qty: e.qty,
                    rate: e.rate,
                    unit: e.unit || 'Units',
                    conv_factor: e.convFactor || 0,
                    stock_qty: e.stockQty || 0
                };
            });

            // Fetch current transaction IDs in DB to handle missing/deleted items
            const { data: currentTxData } = await supabaseClient.from('transactions').select('id');
            if (currentTxData) {
                const localTxIds = new Set(dbTransactions.map(tx => tx.id));
                const missingTxIds = currentTxData.map(tx => tx.id).filter(id => !localTxIds.has(id));

                // If rows were deleted locally, scrub them from the database
                if (missingTxIds.length > 0) {
                    await supabaseClient.from('transactions').delete().in('id', missingTxIds);
                }
            }

            if (dbTransactions.length > 0) {
                const { error } = await supabaseClient
                    .from('transactions')
                    .upsert(dbTransactions, { onConflict: 'id' });
                if (error) throw error;
            }


            // --- 2. HANDLE STOCK ADJUSTMENTS SYNC & DELETIONS ---
            if (parsedState.stockAdjustments) {
                try {
                    const dbStockMapped = parsedState.stockAdjustments.map(adj => ({
                        id: adj.id || uid(),
                        batch_id: adj.batchId,
                        date: adj.date,
                        commodity: adj.commodity,
                        direction: adj.direction,
                        qty: adj.qty,
                        description: adj.description || ''
                    }));

                    // Fetch current stock adjustment IDs in DB to discover hard deletions
                    const { data: currentStockData } = await supabaseClient.from('stock_adjustments').select('id');
                    if (currentStockData) {
                        const localStockIds = new Set(dbStockMapped.map(s => s.id));
                        const missingStockIds = currentStockData.map(s => s.id).filter(id => !localStockIds.has(id));

                        if (missingStockIds.length > 0) {
                            await supabaseClient.from('stock_adjustments').delete().in('id', missingStockIds);
                        }
                    }

                    if (dbStockMapped.length > 0) {
                        await supabaseClient.from('stock_adjustments').upsert(dbStockMapped, { onConflict: 'id' });
                    }
                } catch (stockError) {
                    console.warn("Stock database logs sync failed:", stockError);
                }
            }


            // --- 3. TRADERS & LABOR PROFILES (Standard Upsert Only) ---
            if (parsedState.traders && parsedState.traders.length > 0) {
                try {
                    await supabaseClient.from('traders').upsert(parsedState.traders, { onConflict: 'id' });
                } catch (traderError) {
                    console.warn("Traders background sync failed:", traderError);
                }
            }

            if (parsedState.labor && parsedState.labor.length > 0) {
                try {
                    await supabaseClient.from('labor').upsert(parsedState.labor, { onConflict: 'id' });
                } catch (laborError) {
                    console.warn("Labor background sync failed:", laborError);
                }
            }

            // --- 4. OPENING BALANCE SYNC ---
            try {
                await supabaseClient.from('app_settings').upsert({
                    key: 'openingBalance',
                    value: String(parsedState.openingBalance || 0)
                }, { onConflict: 'key' });
            } catch (settingsErr) {
                console.warn("Opening balance sync failed:", settingsErr);
            }

            if (note) note.textContent = 'All data is saved automatically to the cloud.';
            return true;
        } catch (e) {
            console.error("Database write error:", e);
            if (note) note.textContent = 'Pending sync. Saved locally.';
            throw e;
        }
    }
};

        const DRAFT_KEY = 'coconut-cashbook-draft';
        const CATEGORIES = {
            in: ["Copra Sales", "Husk/Shell Sales", "Coconut Oil Sales", "Advance Received", "Other Income"],
            out: ["Coconut Purchase", "Labor Wages", "Transport/Freight", "Loading/Unloading", "Electricity/Fuel", "Commission/Brokerage", "Other Expense"]
        };

        let state = { openingBalance: 0, entries: [], traders: [], labor: [], stockAdjustments: [] };
        let currentType = 'in';
        let currentFilter = 'all';
        let currentDateRange = 'all';
        let editingId = null;
        let currentViewType = 'trader';
        let combinedEditingId = null;

        function checkPurgeLock() {
            const inputVal = document.getElementById('purge-lock-input').value.trim();
            const btn = document.getElementById('purge-data-btn');

            if (inputVal === "RESET") {
                btn.removeAttribute('disabled');
                btn.style.background = 'var(--rust)';
                btn.style.borderColor = 'var(--rust-dark)';
                btn.style.color = '#ffffff';
                btn.style.cursor = 'pointer';
            } else {
                btn.setAttribute('disabled', 'true');
                btn.style.background = '#cbd5e1';
                btn.style.borderColor = '#94a3b8';
                btn.style.color = '#64748b';
                btn.style.cursor = 'not-allowed';
            }
        }

        async function completelyResetAllData() {
            const firstConfirm = await showModal("Are you absolutely sure you want to delete ALL data? This cannot be undone.", true, "⚠️ Warning: Critical Action");
            if (!firstConfirm) return;

            const secondConfirm = await showModal("Final Confirmation: This will clear your entire Cash Book, Traders database, Labor logs, and Stock ledger permanently. Proceed?", true, "🚨 Final Warning");
            if (!secondConfirm) return;

            state = { openingBalance: 0, entries: [], traders: [], labor: [], stockAdjustments: [] };

            const note = document.getElementById('save-note');
            if (note) note.textContent = 'Purging remote system...';

            try {
                // Wipe transactions and stock adjustments in tandem
                await Promise.all([
                    supabaseClient.from('transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
                    supabaseClient.from('stock_adjustments').delete().neq('id', '00000000-0000-0000-0000-000000000000')
                ]);
                if (note) note.textContent = 'All records successfully wiped from cloud.';
            } catch (e) {
                console.error("Database cloud purge failed:", e);
                if (note) note.textContent = 'Wiped locally, cloud sync pending connection.';
            }

            document.getElementById('opening-input').value = 0;
            if (document.getElementById('stk-input-coconuts')) {
                document.getElementById('stk-input-coconuts').value = '';
                document.getElementById('stk-out-copra').value = '';
                document.getElementById('stk-out-husk').value = '';
                document.getElementById('stk-desc').value = '';
            }

            renderTraders();
            renderLabor();
            render();

            document.querySelector('[data-view="dashboard"]').click();
            await showModal("System successfully reset to factory defaults.", false, "System Wiped");
            document.getElementById('purge-lock-input').value = '';
            checkPurgeLock();
        }

        function showModal(message, isConfirm = false, title = "Notice") {
            return new Promise((resolve) => {
                const modal = document.getElementById('custom-modal');
                const titleEl = document.getElementById('modal-title');
                const msgEl = document.getElementById('modal-msg');
                const okBtn = document.getElementById('modal-ok-btn');
                const cancelBtn = document.getElementById('modal-cancel-btn');

                titleEl.textContent = title;
                msgEl.textContent = message;
                cancelBtn.style.display = isConfirm ? 'inline-block' : 'none';
                modal.style.display = 'flex';

                function cleanup(value) {
                    modal.style.display = 'none';
                    okBtn.onclick = null;
                    cancelBtn.onclick = null;
                    resolve(value);
                }
                okBtn.onclick = () => cleanup(true);
                cancelBtn.onclick = () => cleanup(false);
            });
        }

        function downloadCSV() {
            if (state.entries.length === 0) {
                showModal("No entries recorded yet to create a download spreadsheet file.", false, "Export Empty");
                return;
            }
        
            let csvRows = [["Date", "Description", "Trader/Labor", "Category", "Payment Status", "Cash In", "Cash Out", "Running Balance", "Notes"]];
            const sorted = computeBalances();
        
            sorted.forEach(e => {
                csvRows.push([
                    e.date,
                    `"${(e.description || '').replace(/"/g, '""')}"`,
                    `"${(getTraderOrLaborName(e.trader) || '').replace(/"/g, '""')}"`,
                    e.category,
                    e.status || 'Paid',
                    e.type === 'in' ? e.amount : 0,
                    e.type === 'out' ? e.amount : 0,
                    e.balance,
                    `"${(e.notes || '').replace(/"/g, '""')}"`
                ]);
            });
        
            // 1. Join rows into a clean CSV string framework
            let csvString = csvRows.map(r => r.join(",")).join("\n");
        
            // 2. Wrap it inside a standardized Blob object with proper MIME formatting
            let blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        
            // 3. Generate a local blob download link (Universal mobile/desktop bypass method)
            let url = URL.createObjectURL(blob);
            let link = document.createElement("a");
        
            link.setAttribute("href", url);
            link.setAttribute("download", `coconut_cashbook_${new Date().toISOString().slice(0, 10)}.csv`);
        
            document.body.appendChild(link);
            link.click();
        
            // 4. Clean up memory allocations post-execution
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }

        function fmt(n) {
            n = Math.round(Number(n) || 0);
            return '₹' + n.toLocaleString('en-IN');
        }
        function todayStr() {
            return new Date().toISOString().slice(0, 10);
        }

        function uid() {
            // Generates a cryptographically secure, standard UUID v4 string
            return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
                (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
            );
        }

        function saveDraft() {
            try {
                const draft = {
                    date: document.getElementById('f-date').value,
                    description: document.getElementById('f-desc').value,
                    category: document.getElementById('f-category').value,
                    trader: document.getElementById('f-trader') ? document.getElementById('f-trader').value : '',
                    status: document.getElementById('f-status').value,
                    amount: document.getElementById('f-amount').value,
                    notes: document.getElementById('f-notes').value,
                    type: currentType
                };
                localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
            } catch (e) { }
        }

        function loadDraft() {
            try {
                const raw = localStorage.getItem(DRAFT_KEY);
                if (!raw) return;
                const draft = JSON.parse(raw);
                if (draft.date) document.getElementById('f-date').value = draft.date;
                if (typeof draft.description === 'string') document.getElementById('f-desc').value = draft.description;
                if (draft.type) { currentType = draft.type; updateTypeButtons(); }
                populateCategorySelect();
                if (draft.category) document.getElementById('f-category').value = draft.category;
                populateTraderSelect();
                if (draft.trader && document.getElementById('f-trader')) document.getElementById('f-trader').value = draft.trader;
                if (draft.status) document.getElementById('f-status').value = draft.status;
                if (draft.amount) document.getElementById('f-amount').value = draft.amount;
                if (typeof draft.notes === 'string') document.getElementById('f-notes').value = draft.notes;
            } catch (e) { }
        }

        function populateCategorySelect() {
            const sel = document.getElementById('f-category');
            const prevVal = sel.value;
            sel.innerHTML = '';
            CATEGORIES[currentType].forEach(c => {
                const opt = document.createElement('option');
                opt.value = c; opt.textContent = c;
                sel.appendChild(opt);
            });
            if (prevVal && CATEGORIES[currentType].includes(prevVal)) {
                sel.value = prevVal;
            }
}

        // --- Combined Traders & Labor Controller Logic ---
        function switchCombinedView(type) {
            currentViewType = type;
            combinedEditingId = null;
            
            const nameLabel = document.getElementById('dynamic-name-label');
            const nameInput = document.getElementById('entity-name');
            const saveBtn = document.getElementById('entity-save');
            const cancelBtn = document.getElementById('entity-cancel');
            const tableHeaders = document.getElementById('dynamic-table-headers');
            
            if (!nameInput) return; // Guard if elements aren't injected into DOM yet

            nameInput.value = '';
            const phoneEl = document.getElementById('entity-phone');
            if (phoneEl) phoneEl.value = '';
            if (cancelBtn) cancelBtn.style.display = 'none';

            if (type === 'trader') {
                if (nameLabel) nameLabel.textContent = 'Trader Name';
                nameInput.placeholder = 'e.g. Murugan Traders';
                if (saveBtn) saveBtn.textContent = 'Add Trader';
                if (tableHeaders) {
                    tableHeaders.innerHTML = `<th>Trader Name</th><th>Phone</th><th style="text-align:right;">Net Balance</th><th></th>`;
                }
            } else {
                if (nameLabel) nameLabel.textContent = 'Labor Worker Name';
                nameInput.placeholder = 'e.g. Ramesh Kumar';
                if (saveBtn) saveBtn.textContent = 'Add Worker';
                if (tableHeaders) {
                    tableHeaders.innerHTML = `<th>Worker Name</th><th>Phone</th><th style="text-align:right;">Net Paid / Owed</th><th></th>`;
                }
            }
            renderCombinedEntities();
        }

        async function saveCombinedEntity() {
            const nameEl = document.getElementById('entity-name');
            const phoneEl = document.getElementById('entity-phone');
            if (!nameEl) return;
            
            const name = (nameEl.value || '').trim();
            const phone = phoneEl ? (phoneEl.value || '').trim() : '';
            
            if (!name) {
                await showModal('Please enter a valid name.', false, 'Missing Name');
                nameEl.focus();
                return;
            }

            if (currentViewType === 'trader') {
                if (combinedEditingId) {
                    const t = state.traders.find(x => x.id === combinedEditingId);
                    if (t) Object.assign(t, { name, phone });
                } else {
                    state.traders.push({ id: uid(), name, phone });
                }
            } else {
                if (combinedEditingId) {
                    const l = state.labor.find(x => x.id === combinedEditingId);
                    if (l) Object.assign(l, { name, phone });
                } else {
                    state.labor.push({ id: uid(), name, phone });
                }
            }

            combinedEditingId = null;
            document.getElementById('entity-save').textContent = currentViewType === 'trader' ? 'Add Trader' : 'Add Worker';
            document.getElementById('entity-cancel').style.display = 'none';
            
            await window.storage.set(STORAGE_KEY, JSON.stringify(state));
            nameEl.value = '';
            if (phoneEl) phoneEl.value = '';
            
            renderCombinedEntities();
            populateTraderSelect();
            render();
        }

        function renderCombinedEntities() {
            const body = document.getElementById('combined-entity-body');
            if (!body) return;
            body.innerHTML = '';

            if (currentViewType === 'trader') {
                if (!state.traders || state.traders.length === 0) {
                    body.innerHTML = '<tr><td colspan="4" class="empty-note" style="padding:18px;">No traders yet.</td></tr>';
                    return;
                }
                state.traders.forEach(t => {
                    const tEntries = state.entries.filter(e => e.trader === t.id);
                    const totalIn = tEntries.filter(e => e.type === 'in').reduce((sum, e) => sum + e.amount, 0);
                    const totalOut = tEntries.filter(e => e.type === 'out').reduce((sum, e) => sum + e.amount, 0);
                    const netBal = totalIn - totalOut;
                    let balColor = netBal > 0 ? '#2e7d32' : (netBal < 0 ? '#c62828' : '#2B2419');

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${escapeHtml(t.name)}</td>
                        <td>${escapeHtml(t.phone || '')}</td>
                        <td class="num" style="font-weight:700; color:${balColor}; text-align:right;">${fmt(netBal)}</td>
                        <td class="row-actions">
                            <button class="edit-entity icon-btn" data-id="${t.id}" title="Edit">✏️</button>
                            <button class="del-entity icon-btn" data-id="${t.id}" title="Delete">🗑️</button>
                        </td>`;
                    body.appendChild(tr);
                });
            } else {
                if (!state.labor || state.labor.length === 0) {
                    body.innerHTML = '<tr><td colspan="4" class="empty-note" style="padding:18px;">No labor records yet.</td></tr>';
                    return;
                }
                state.labor.forEach(l => {
                    const lEntries = state.entries.filter(e => e.trader === l.id);
                    const totalIn = lEntries.filter(e => e.type === 'in').reduce((sum, e) => sum + e.amount, 0);
                    const totalOut = lEntries.filter(e => e.type === 'out').reduce((sum, e) => sum + e.amount, 0);
                    const netBal = totalOut - totalIn;
                    let balColor = netBal > 0 ? '#c62828' : (netBal < 0 ? '#2e7d32' : '#2B2419');

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${escapeHtml(l.name)}</td>
                        <td>${escapeHtml(l.phone || '')}</td>
                        <td class="num" style="font-weight:700; color:${balColor}; text-align:right;">${fmt(netBal)}</td>
                        <td class="row-actions">
                            <button class="edit-entity icon-btn" data-id="${l.id}" title="Edit">✏️</button>
                            <button class="del-entity icon-btn" data-id="${l.id}" title="Delete">🗑️</button>
                        </td>`;
                    body.appendChild(tr);
                });
            }

            body.querySelectorAll('.edit-entity').forEach(b => b.addEventListener('click', () => startCombinedEdit(b.dataset.id)));
            body.querySelectorAll('.del-entity').forEach(b => b.addEventListener('click', () => deleteCombinedEntityWithConfirm(b.dataset.id)));
        }

        function startCombinedEdit(id) {
            const entity = currentViewType === 'trader' 
                ? state.traders.find(x => x.id === id)
                : state.labor.find(x => x.id === id);
            if (!entity) return;
            
            combinedEditingId = id;
            document.getElementById('entity-name').value = entity.name;
            document.getElementById('entity-phone').value = entity.phone || '';
            document.getElementById('entity-save').textContent = 'Save changes';
            document.getElementById('entity-cancel').style.display = 'inline-block';
        }

        function cancelCombinedEdit() {
            combinedEditingId = null;
            document.getElementById('entity-save').textContent = currentViewType === 'trader' ? 'Add Trader' : 'Add Worker';
            document.getElementById('entity-cancel').style.display = 'none';
            document.getElementById('entity-name').value = '';
            document.getElementById('entity-phone').value = '';
        }

        async function deleteCombinedEntityWithConfirm(id) {
            const entityName = currentViewType === 'trader' ? 'Trader' : 'Labor worker';
            const collection = currentViewType === 'trader' ? state.traders : state.labor;
            const item = collection.find(x => x.id === id);
            if (!item) return;

            if (state.entries.filter(e => e.trader === id).length > 0) {
                await showModal(`${entityName} "${item.name}" is referenced in cash transactions and cannot be deleted.`, false, 'Cannot Delete');
                return;
            }
            if (!await showModal(`Delete ${entityName.toLowerCase()} "${item.name}"?`, true, 'Confirm Deletion')) return;

            if (currentViewType === 'trader') {
                state.traders = state.traders.filter(x => x.id !== id);
            } else {
                state.labor = state.labor.filter(x => x.id !== id);
            }

            await window.storage.set(STORAGE_KEY, JSON.stringify(state));
            renderCombinedEntities();
            populateTraderSelect();
            render();
        }

        function populateTraderSelect() {
            const sel = document.getElementById('f-trader');
            const labelEl = document.getElementById('trader-field-label');
            const categoryEl = document.getElementById('f-category');
            if (!sel) return;

            const prevSelection = sel.value;
            sel.innerHTML = '';
            const none = document.createElement('option'); none.value = ''; none.textContent = '— none —';
            sel.appendChild(none);

            if (categoryEl && categoryEl.value === "Labor Wages") {
                if (labelEl) labelEl.textContent = "Labor Worker";
                state.labor.forEach(l => {
                    const opt = document.createElement('option'); opt.value = l.id; opt.textContent = l.name + (l.phone ? (' — ' + l.phone) : '');
                    sel.appendChild(opt);
                });
            } else {
                if (labelEl) labelEl.textContent = "Trader";
                state.traders.forEach(t => {
                    const opt = document.createElement('option'); opt.value = t.id; opt.textContent = t.name + (t.phone ? (' — ' + t.phone) : '');
                    sel.appendChild(opt);
                });
            }
            sel.value = prevSelection || '';
        }

        function getTraderOrLaborName(id) {
            if (!id) return '';
            const matchedTrader = state.traders.find(t => t.id === id);
            if (matchedTrader) return matchedTrader.name;
            const matchedLabor = state.labor.find(l => l.id === id);
            return matchedLabor ? matchedLabor.name : '';
        }

        function sortedEntries() {
            return [...state.entries].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : (a._seq || 0) - (b._seq || 0)));
        }

        function computeBalances() {
            const sorted = sortedEntries();
            let bal = state.openingBalance;
            return sorted.map(e => {
                bal += (e.type === 'in' ? e.amount : -e.amount);
                return { ...e, balance: bal };
            });
        }

        async function saveProcessingBatch() {
            const date = document.getElementById('stk-date').value;
            const inputCoconuts = parseFloat(document.getElementById('stk-input-coconuts').value);
            const outCopra = parseFloat(document.getElementById('stk-out-copra').value) || 0;
            const outHusk = parseFloat(document.getElementById('stk-out-husk').value) || 0;
            const description = document.getElementById('stk-desc').value.trim();

            if (!date) {
                await showModal('Please select an entry date.', false, 'Missing Date');
                return;
            }
            if (isNaN(inputCoconuts) || inputCoconuts <= 0) {
                await showModal('Please enter the number of raw coconuts used.', false, 'Invalid Input');
                return;
            }

            if (!state.stockAdjustments) {
                state.stockAdjustments = [];
            }

            const batchId = 'batch-' + Date.now().toString(36);
            const notes = description || `Batch processing run`;

            state.stockAdjustments.push({
                id: uid(), batchId, date, commodity: 'Coconuts', direction: 'reduction', qty: inputCoconuts, description: `${notes} (Coconuts Used)`
            });

            if (outCopra > 0) {
                state.stockAdjustments.push({
                    id: uid(), batchId, date, commodity: 'Copra', direction: 'addition', qty: outCopra, description: `${notes} (Copra Yield)`
                });
            }

            if (outHusk > 0) {
                state.stockAdjustments.push({
                    id: uid(), batchId, date, commodity: 'Husk/Shell', direction: 'addition', qty: outHusk, description: `${notes} (Husk Yield)`
                });
            }

            await window.storage.set(STORAGE_KEY, JSON.stringify(state));

            document.getElementById('stk-input-coconuts').value = '';
            document.getElementById('stk-out-copra').value = '';
            document.getElementById('stk-out-husk').value = '';
            document.getElementById('stk-desc').value = '';

            render();
        }

        async function deleteProcessingBatch(batchId) {
            if (!await showModal("Permanently remove all stock changes linked to this processing batch?", true, "Confirm Deletion")) return;
            if (state.stockAdjustments) {
                // Filter down array parameters locally
                state.stockAdjustments = state.stockAdjustments.filter(adj => adj.batchId !== batchId);
                
                // Trigger the database validation pipeline instantly
                await window.storage.set(STORAGE_KEY, JSON.stringify(state));
                
                // Re-render dashboard balances alongside inventory ledger views
                render(); 
            }
        }

        function renderInventoryLedger() {
            const kpiContainer = document.getElementById('stock-kpis');
            const body = document.getElementById('inventory-body');
            if (!kpiContainer || !body) return;
        
            if (!document.getElementById('stk-date').value) {
                document.getElementById('stk-date').value = todayStr();
            }
        
            const inventoryTotals = { "Coconuts": 0, "Copra": 0, "Husk/Shell": 0, "Oil": 0 };
            const stockMovements = [];
        
            sortedEntries().forEach(e => {
                const ledgerQty = e.stockQty !== undefined && e.stockQty !== null ? e.stockQty : (e.qty || 0);
                if (ledgerQty <= 0) return;

                let commodity = "Coconuts";
                const cat = (e.category || '').toLowerCase();

                if (cat.includes("copra")) commodity = "Copra";
                else if (cat.includes("oil")) commodity = "Oil";
                else if (cat.includes("water")) commodity = "Water";
                else if (cat.includes("husk") || cat.includes("shell")) commodity = "Husk/Shell";
        
                const isPurchase = (e.type === 'out');
        
                // 🚨 THE REAL-WORLD FIX
                if (isPurchase) {
                    // Any purchase (Cash Out) ONLY adds to raw Coconuts.
                    // It completely ignores Copra/Husk categories here because they aren't processed yet!
                    inventoryTotals["Coconuts"] += ledgerQty;
                } else {
                    // Sales (Cash In) cleanly deduct from the specific finished item sold
                    inventoryTotals[commodity] -= ledgerQty;
                }
        
                const directionText = isPurchase ? "➕ Inbound Stock Purchase" : "➖ Outbound Stock Sale";
        
                const displayNotes = e.unit === 'Ton'
                    ? `${getTraderOrLaborName(e.trader) || 'Direct Transaction'} (${e.qty} Ton @ ₹${e.rate}/Ton)`
                    : (getTraderOrLaborName(e.trader) || 'Direct Transaction');
        
                stockMovements.push({
                    date: e.date,
                    commodity: isPurchase ? "Coconuts" : commodity, // Force purchase to display as raw coconuts
                    direction: directionText,
                    qty: ledgerQty,
                    rate: e.unit === 'Ton' ? 0 : (e.rate || 0),
                    party: displayNotes,
                    isAdjustment: false
                });
            });
        
            // Account for batch process updates cleanly with standardized commodity tags
            if (state.stockAdjustments && Array.isArray(state.stockAdjustments)) {
                state.stockAdjustments.forEach(adj => {
                    let commodity = adj.commodity;

                    // Normalize variants like "Husk/Shell", "Husk Yield", or "Husk"
                    if (commodity && (commodity.includes("Husk") || commodity.includes("Shell"))) {
                        commodity = "Husk/Shell";
                    } else if (commodity && commodity.includes("Copra")) {
                        commodity = "Copra";
                    } else if (commodity && commodity.includes("Coconut")) {
                        commodity = "Coconuts";
                    }

                    if (inventoryTotals[commodity] !== undefined) {
                        if (adj.direction === 'addition') {
                            inventoryTotals[commodity] += adj.qty;
                        } else {
                            inventoryTotals[commodity] -= adj.qty;
                        }
                    }

                    // ✨ PUSH BATCHES INTO THE LAYOUT DISPLAY GRID ARRAY
                    stockMovements.push({
                        date: adj.date,
                        commodity: commodity,
                        direction: adj.direction === 'addition' ? "➕ Production Yield" : "➖ Processing Intake",
                        qty: adj.qty,
                        rate: 0,
                        party: adj.description || 'Internal Processing Run',
                        isAdjustment: true,
                        batchId: adj.batchId
                    });
                });
            }
        
            stockMovements.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
        
            let totalCoconutsProcessed = 0;
            let totalCopraProduced = 0;

            if (state.stockAdjustments && Array.isArray(state.stockAdjustments)) {
                state.stockAdjustments.forEach(adj => {
                    if (adj.commodity === "Coconuts" && adj.direction === "reduction") {
                        totalCoconutsProcessed += adj.qty;
                    }
                    if (adj.commodity === "Copra" && adj.direction === "addition") {
                        totalCopraProduced += adj.qty;
                    }
                });
            }

            // Calculate conversion metrics safely to avoid division by zero
            let yieldText = "No batches run yet";
            if (totalCoconutsProcessed > 0 && totalCopraProduced > 0) {
                const kgPerNut = (totalCopraProduced / totalCoconutsProcessed).toFixed(3);
                const nutsPerKg = (totalCoconutsProcessed / totalCopraProduced).toFixed(1);
                yieldText = `${kgPerNut} KG / nut (${nutsPerKg} nuts/KG)`;
            }


            // --- 2. Render all 4 KPI Cards (Stock balances + Yield metrics) ---
            kpiContainer.innerHTML = Object.keys(inventoryTotals).map(item => {
                const displayUnit = item === "Copra" ? "KG" : "Units";
                return `
            <div class="kpi">
                <div class="label">${item} Balance Stock</div>
                <div class="value" style="color: var(--palm-dark); font-weight: bold;">
                    ${inventoryTotals[item].toLocaleString()} ${displayUnit}
                </div>
            </div>
            `;
                }).join('') + `
            <div class="kpi" style="border-left: 4px solid var(--palm-dark, #2e7d32);">
                <div class="label" style="color: var(--palm-dark); font-weight: 600;">Copra Yield Efficiency</div>
                <div class="value" style="color: #1b5e20; font-size: 1.3rem;">${yieldText}</div>
            </div>
        `;
        
            body.innerHTML = '';
            if (stockMovements.length === 0) {
                body.innerHTML = '<tr><td colspan="6" class="empty-note" style="padding:18px;">No stock logs found. Use the processing form to run transformations.</td></tr>';
                return;
            }
        
            const renderedBatches = new Set();
        
            stockMovements.reverse().forEach(sm => {
                const tr = document.createElement('tr');
                let actionMarkup = '';
                if (sm.isAdjustment && sm.batchId && !renderedBatches.has(sm.batchId)) {
                    actionMarkup = `<button onclick="deleteProcessingBatch('${sm.batchId}')" style="color:var(--rust-dark); background:none; border:none; cursor:pointer; font-size:11px; margin-left:8px; font-weight:bold;">❌ Delete Entire Batch</button>`;
                    renderedBatches.add(sm.batchId);
                }
        
                tr.innerHTML = `
                        <td>${sm.date}</td>
                        <td><span class="cat-tag">${sm.commodity}</span></td>
                        <td style="font-weight: 600; color: ${sm.direction.includes('➕') ? 'var(--palm-dark)' : 'var(--rust-dark)'}">${sm.direction}</td>
                        <td class="num">${sm.qty.toLocaleString()}</td>
                        <td class="num">${sm.rate > 0 ? '₹' + sm.rate : '—'}</td>
                        <td>${escapeHtml(sm.party)} ${actionMarkup}</td>
                    `;
                body.appendChild(tr);
            });
        }

        function matchDateRange(entryDate) {
            if (currentDateRange === 'all') return true;

            const targetDate = new Date(entryDate);
            targetDate.setHours(0, 0, 0, 0);

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            if (currentDateRange === 'today') return targetDate.getTime() === today.getTime();
            if (currentDateRange === 'month') return targetDate.getMonth() === today.getMonth() && targetDate.getFullYear() === today.getFullYear();

            if (currentDateRange === 'lastmonth') {
                const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                return targetDate.getMonth() === lastMonth.getMonth() && targetDate.getFullYear() === lastMonth.getFullYear();
            }
            if (currentDateRange === 'custom') {
                const startInput = document.getElementById('filter-start-date').value;
                const endInput = document.getElementById('filter-end-date').value;
                if (!startInput || !endInput) return true;

                const start = new Date(startInput); start.setHours(0, 0, 0, 0);
                const end = new Date(endInput); end.setHours(23, 59, 59, 999);
                return targetDate >= start && targetDate <= end;
            }
            return true;
        }

        function render() {
            renderCashBook();
            renderDashboard();
            renderSummary();
            renderInventoryLedger();
        }

        async function toggleStatusDirectly(id) {
            const entry = state.entries.find(e => e.id === id);
            if (!entry) return;
            entry.status = (entry.status === 'Pending') ? 'Paid' : 'Pending';
            await window.storage.set(STORAGE_KEY, JSON.stringify(state));
            render();
        }

        function renderCashBook() {
            const body = document.getElementById('entries-body');
            body.innerHTML = '';
            const withBal = computeBalances();

            const filteredEntries = withBal.filter(e => {
                const typeMatches = (currentFilter === 'all' || e.type === currentFilter);
                const dateMatches = matchDateRange(e.date);
                return typeMatches && dateMatches;
            });

            filteredEntries.reverse();

            if (filteredEntries.length === 0) {
                body.innerHTML = `<tr><td colspan="9" class="empty-note" style="padding:24px;">No transactions match the filter parameters.</td></tr>`;
                return;
            }

            filteredEntries.forEach(e => {
                const tr = document.createElement('tr');
                const isPending = e.status === 'Pending';
                if (isPending) tr.classList.add('pending-row');

                tr.innerHTML = `
                        <td>${e.date}</td>
                        <td>${escapeHtml(e.description || '')}</td>
                        <td>${escapeHtml(getTraderOrLaborName(e.trader))}</td>
                        <td><span class="cat-tag">${escapeHtml(e.category)}</span></td>
                        <td><span class="status-badge ${isPending ? 'pending' : 'paid'}" onclick="toggleStatusDirectly('${e.id}')">${isPending ? 'PENDING' : 'PAID'}</span></td>
                        <td class="num in">${e.type === 'in' ? fmt(e.amount) : ''}</td>
                        <td class="num out">${e.type === 'out' ? fmt(e.amount) : ''}</td>
                        <td class="num bal ${e.balance < 0 ? 'negative' : ''}">${fmt(e.balance)}</td>
                        <td class="row-actions">
                          <button class="icon-btn" data-copy="${e.id}" title="Copy">📋</button>
                          <button class="icon-btn" data-edit="${e.id}" title="Edit">✏️</button>
                          <button class="icon-btn" data-del="${e.id}" title="Delete">🗑️</button>
                        </td>`;
                body.appendChild(tr);
            });
            body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => startEdit(b.dataset.edit)));
            body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEntry(b.dataset.del)));
            body.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => quickCopyEntry(b.dataset.copy)));
        }

        function quickCopyEntry(id) {
            const e = state.entries.find(x => x.id === id);
            if (!e) return;
            cancelEdit();
            currentType = e.type;
            document.querySelector('[data-view="cashbook"]').click();
            updateTypeButtons();
            populateCategorySelect();
            document.getElementById('f-category').value = e.category;
            populateTraderSelect();
            document.getElementById('f-date').value = todayStr();
            document.getElementById('f-desc').value = e.description || '';
            document.getElementById('f-status').value = e.status || 'Paid';
            document.getElementById('f-amount').value = e.amount;
            document.getElementById('f-notes').value = e.notes || '';
            if (document.getElementById('f-trader')) document.getElementById('f-trader').value = e.trader || '';
            saveDraft();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function escapeHtml(s) {
            const d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        }

        function renderDashboard() {
            // 1. Calculate Cash Metrics
            const totalIn = state.entries.filter(e => e.type === 'in').reduce((s, e) => s + e.amount, 0);
            const totalOut = state.entries.filter(e => e.type === 'out').reduce((s, e) => s + e.amount, 0);
            const balance = state.openingBalance + totalIn - totalOut;
            const pendingIn = state.entries.filter(e => e.type === 'in' && e.status === 'Pending').reduce((s, e) => s + e.amount, 0);
            const pendingOut = state.entries.filter(e => e.type === 'out' && e.status === 'Pending').reduce((s, e) => s + e.amount, 0);

            document.getElementById('kpi-balance').textContent = fmt(balance);
            document.getElementById('kpi-in').textContent = fmt(totalIn);
            document.getElementById('kpi-out').textContent = fmt(totalOut);
            document.getElementById('kpi-pending-receivable').textContent = fmt(pendingIn);
            document.getElementById('kpi-pending-payable').textContent = fmt(pendingOut);

            const thisMonth = todayStr().slice(0, 7);
            const mIn = state.entries.filter(e => e.type === 'in' && e.date.slice(0, 7) === thisMonth).reduce((s, e) => s + e.amount, 0);
            const mOut = state.entries.filter(e => e.type === 'out' && e.date.slice(0, 7) === thisMonth).reduce((s, e) => s + e.amount, 0);
            document.getElementById('kpi-month-net').textContent = fmt(mIn - mOut);

            // 2. Calculate Real-Time Stock Metrics
            const inventoryTotals = { "Coconuts": 0, "Copra": 0, "Husk/Shell": 0 };

            // Account for sales and purchases safely
            state.entries.forEach(e => {
                const ledgerQty = e.stockQty !== undefined && e.stockQty !== null ? e.stockQty : (e.qty || 0);
                if (ledgerQty <= 0) return;

                let commodity = "Coconuts";
                if (e.category && e.category.includes("Copra")) commodity = "Copra";
                else if (e.category && (e.category.includes("Husk") || e.category.includes("Shell"))) commodity = "Husk/Shell";

                if (e.type === 'out') {
                    inventoryTotals["Coconuts"] += ledgerQty; // Purchases strictly go to Raw Coconuts
                } else {
                    inventoryTotals[commodity] -= ledgerQty;  // Sales drop specific counts
                }
            });

            // Account for batch process updates
            if (state.stockAdjustments && Array.isArray(state.stockAdjustments)) {
                state.stockAdjustments.forEach(adj => {
                    if (inventoryTotals[adj.commodity] !== undefined) {
                        if (adj.direction === 'addition') {
                            inventoryTotals[adj.commodity] += adj.qty;
                        } else {
                            inventoryTotals[adj.commodity] -= adj.qty;
                        }
                    }
                });
            }

            // Render Stock KPI cards onto Dashboard
            const stockKpiContainer = document.getElementById('dashboard-stock-kpis');
            if (stockKpiContainer) {
                stockKpiContainer.innerHTML = Object.keys(inventoryTotals).map(item => `
                    <div class="kpi">
                        <div class="label">${item === "Coconuts" ? "Raw Coconuts" : item} On Hand</div>
                        <div class="value" style="color: var(--palm-dark, #2e7d32); font-weight: bold;">
                            ${inventoryTotals[item].toLocaleString()} ${item === "Copra" ? "KG" : "Units"}
                        </div>
                    </div>
                `).join('');
            }
        }

        function renderSummary() {
            const monthMap = {};
            state.entries.forEach(e => {
                const m = e.date ? e.date.slice(0, 7) : 'unknown';
                if (!monthMap[m]) monthMap[m] = { in: 0, out: 0 };
                monthMap[m][e.type] += e.amount;
            });
            const months = Object.keys(monthMap).sort();
            const mbody = document.getElementById('monthly-body');
            mbody.innerHTML = '';
            if (months.length === 0) {
                mbody.innerHTML = '<tr><td colspan="4" class="empty-note">No data yet.</td></tr>';
            } else {
                months.forEach(m => {
                    const { in: mi, out: mo } = monthMap[m];
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td>${m}</td><td class="num in">${fmt(mi)}</td><td class="num out">${fmt(mo)}</td><td class="num">${fmt(mi - mo)}</td>`;
                    mbody.appendChild(tr);
                });
            }

            const catIn = document.getElementById('cat-in-body');
            const catOut = document.getElementById('cat-out-body');
            catIn.innerHTML = ''; catOut.innerHTML = '';
            CATEGORIES.in.forEach(c => {
                const total = state.entries.filter(e => e.type === 'in' && e.category === c).reduce((s, e) => s + e.amount, 0);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${c}</td><td class="num">${fmt(total)}</td>`;
                catIn.appendChild(tr);
            });
            CATEGORIES.out.forEach(c => {
                const total = state.entries.filter(e => e.type === 'out' && e.category === c).reduce((s, e) => s + e.amount, 0);
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${c}</td><td class="num">${fmt(total)}</td>`;
                catOut.appendChild(tr);
            });

            const analyticsBody = document.getElementById('analytics-body');
            const analyticsKpis = document.getElementById('analytics-kpis');

            if (analyticsBody && analyticsKpis) {
                const streams = {
                    "Coconuts": { in: 0, out: 0 },
                    "Copra": { in: 0, out: 0 },
                    "Oil": { in: 0, out: 0 },
                    "Husk/Shell": { in: 0, out: 0 },
                    "Other/General": { in: 0, out: 0 }
                };

                let operationalExpenses = 0;
                let totalIncomeFramework = 0;

                state.entries.forEach(e => {
                    let assigned = false;
                    const cat = e.category || '';

                    Object.keys(streams).forEach(stream => {
                        if (cat.includes(stream) || (stream === "Husk/Shell" && cat.includes("Husk"))) {
                            streams[stream][e.type] += e.amount;
                            assigned = true;
                        }
                    });

                    if (!assigned) {
                        if (e.type === 'out') {
                            operationalExpenses += e.amount;
                        } else {
                            streams["Other/General"]['in'] += e.amount;
                        }
                    }

                    if (e.type === 'in') totalIncomeFramework += e.amount;
                });

                analyticsBody.innerHTML = '';
                Object.keys(streams).forEach(stream => {
                    const data = streams[stream];
                    const netMargin = data.in - data.out;
                    const totalCost = data.out;

                    const pi = totalCost > 0 ? (data.in / totalCost).toFixed(2) : (data.in > 0 ? '∞' : '0.00');
                    const marginColor = netMargin >= 0 ? 'var(--palm-dark)' : 'var(--rust-dark)';

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                            <td><span class="cat-tag">${stream}</span></td>
                            <td class="num in">${fmt(data.in)}</td>
                            <td class="num out">${fmt(data.out)}</td>
                            <td class="num" style="font-weight:700; color:${marginColor}">${fmt(netMargin)}</td>
                            <td class="num" style="font-weight:700; color:${pi > 1 || pi === '∞' ? 'var(--palm-dark)' : 'var(--ink)'}">${pi}x</td>
                        `;
                    analyticsBody.appendChild(tr);
                });

                const totalDirectCost = Object.values(streams).reduce((acc, curr) => acc + curr.out, 0);
                const netProductMargin = totalIncomeFramework - totalDirectCost - operationalExpenses;
                const roiPercent = (totalDirectCost + operationalExpenses) > 0
                    ? (((totalIncomeFramework) / (totalDirectCost + operationalExpenses)) * 100 - 100).toFixed(1)
                    : '0.0';

                analyticsKpis.innerHTML = `
                        <div class="kpi">
                            <div class="label">Indirect Overhead (Labor/Freight)</div>
                            <div class="value" style="color: var(--rust-dark);">${fmt(operationalExpenses)}</div>
                        </div>
                        <div class="kpi">
                            <div class="label">Net Enterprise Profit</div>
                            <div class="value" style="color: ${netProductMargin >= 0 ? 'var(--palm-dark)' : 'var(--rust-dark)'}; font-weight: bold;">${fmt(netProductMargin)}</div>
                        </div>
                        <div class="kpi">
                            <div class="label">Return on Capital Invested</div>
                            <div class="value" style="color: var(--husk-dark); font-weight: bold;">${roiPercent}%</div>
                        </div>
                    `;
            }
        }

        function triggerUnitLabelUpdate() {
            const currentUnit = document.getElementById('f-unit').value;
            const convBox = document.getElementById('conversion-box');

            if (currentUnit === 'Ton') {
                document.getElementById('qty-field-label').textContent = 'Quantity (Tons)';
                document.getElementById('rate-field-label').textContent = 'Rate per Ton (₹)';
                convBox.style.display = 'block';
            } else {
                document.getElementById('qty-field-label').textContent = 'Quantity (Units)';
                document.getElementById('rate-field-label').textContent = 'Rate per Unit (₹)';
                convBox.style.display = 'none';
                document.getElementById('f-conv').value = '';
            }
        }

        document.addEventListener('change', async (event) => {
            if (event.target && event.target.id === 'f-unit') {
                triggerUnitLabelUpdate();
            }
            if (event.target && event.target.id === 'f-category') {
                populateTraderSelect();
            }
            if (event.target && event.target.id === 'calc-toggle') {
                const calcFields = document.getElementById('calc-fields');
                const amountInput = document.getElementById('f-amount');
                if (event.target.checked) {
                    calcFields.style.display = 'flex';
                    amountInput.readOnly = true;
                    amountInput.style.background = '#f4f1ea';
                    suggestLastRate();
                } else {
                    calcFields.style.display = 'none';
                    amountInput.readOnly = false;
                    amountInput.style.background = '';
                    document.getElementById('f-qty').value = '';
                    document.getElementById('f-rate').value = '';
                }
            }
            if (event.target && (event.target.id === 'filter-start-date' || event.target.id === 'filter-end-date')) {
                renderCashBook();
            }
        });

        document.addEventListener('input', async (event) => {
            // Check if user is editing quantity or rate parameters
            if (event.target && (event.target.id === 'f-qty' || event.target.id === 'f-rate')) {
                const categoryEl = document.getElementById('f-category');
                const category = categoryEl ? categoryEl.value : '';
                
                const qty = parseFloat(document.getElementById('f-qty').value) || 0;
                const rate = parseFloat(document.getElementById('f-rate').value) || 0;
                const total = qty * rate;
                
                const amountInput = document.getElementById('f-amount');
                if (amountInput) {
                    amountInput.value = total > 0 ? total.toFixed(2) : '';
                }
            }
        });

        document.addEventListener('click', async (event) => {
            if (event.target && event.target.id === 'cancel-edit') {
                cancelEdit();
            }

            if (event.target && event.target.id === 'save-entry') {
                const dateInputEl = document.getElementById('f-date');
                const date = dateInputEl ? dateInputEl.value : '';

                if (!date) {
                    await showModal('Please select a valid date for the entry.', false, 'Missing Date');
                    return;
                }

                const desc = document.getElementById('f-desc').value.trim();
                const category = document.getElementById('f-category').value;
                const status = document.getElementById('f-status').value;
                const amount = parseFloat(document.getElementById('f-amount').value);
                const notes = document.getElementById('f-notes').value.trim();
                const trader = document.getElementById('f-trader').value || '';
                const isCalcActive = document.getElementById('calc-toggle').checked;

                const unit = isCalcActive ? document.getElementById('f-unit').value : 'Units';
                const qty = isCalcActive ? parseFloat(document.getElementById('f-qty').value) || 0 : null;
                const rate = isCalcActive ? parseFloat(document.getElementById('f-rate').value) || 0 : null;
                const convFactor = isCalcActive ? parseInt(document.getElementById('f-conv').value) || 0 : 0;

                let stockQty = 0;
                if (isCalcActive && qty > 0) {
                    if (unit === 'Ton') {
                        stockQty = convFactor > 0 ? Math.round(qty * convFactor) : 0;
                    } else {
                        stockQty = Math.round(qty);
                    }
                } else if (!isCalcActive) {
                    const inlineMatches = desc.match(/\b\d+\b/);
                    if (inlineMatches) stockQty = parseInt(inlineMatches[0], 10);
                }

                if (!amount || amount <= 0) {
                    await showModal('Enter an amount greater than 0.', false, 'Invalid Amount');
                    return;
                }
                if (!desc && !trader) {
                    await showModal(`Please provide either a Description or select a stakeholder party.`, false, 'Missing Information');
                    return;
                }

                if (isCalcActive && stockQty <= 0) {
                    await showModal('Please specify a valid quantity greater than 0 to correctly update the Stock Ledger.', false, 'Invalid Quantity');
                    return;
                }

                const openingVal = parseFloat(document.getElementById('opening-input').value);
                state.openingBalance = isNaN(openingVal) ? 0 : openingVal;

                if (editingId) {
                    const e = state.entries.find(x => x.id === editingId);
                    Object.assign(e, { date, description: desc, category, type: currentType, status, amount, notes, trader, qty, rate, unit, convFactor, stockQty });
                    editingId = null;
                } else {
                    state.entries.push({
                        id: uid(), _seq: state.entries.length,
                        date, description: desc, category, type: currentType, status, amount, notes, trader, qty, rate, unit, convFactor, stockQty
                    });
                }
                await window.storage.set(STORAGE_KEY, JSON.stringify(state));
                clearForm();
                render();
            }

            // --- OPENING CASH BALANCE TOGGLE ---
            if (event.target && event.target.closest('#edit-opening-balance-btn')) {
                const btn = event.target.closest('#edit-opening-balance-btn');
                const input = document.getElementById('opening-input');

                if (input.disabled) {
                    // EDIT MODE
                    input.disabled = false;
                    input.focus();

                    btn.style.background = '#e8f5e9';
                    btn.style.borderColor = '#2e7d32';
                    btn.style.color = '#2e7d32';
                    btn.title = "Save Balance";
                    btn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    `;
                } else {
                    // SAVE MODE
                    const v = parseFloat(input.value);
                    state.openingBalance = isNaN(v) ? 0 : v;
                    input.disabled = true;

                    // Restore original vector edit icon styling
                    btn.style.background = '#d1dfd8';
                    btn.style.borderColor = '#2e4d3e';
                    btn.style.color = '#2e4d3e';
                    btn.title = "Edit Balance";
                    btn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    `;

                    await window.storage.set(STORAGE_KEY, JSON.stringify(state));
                    render();
                }
            }

            if (event.target.classList.contains('sel-in') || event.target.classList.contains('sel-out')) {
                const btn = event.target;
                currentType = btn.dataset.type;
                updateTypeButtons();
                populateCategorySelect();
                populateTraderSelect();
            }

            if (event.target.classList.contains('filter-btn')) {
                const btn = event.target;
                event.stopPropagation();
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                currentFilter = btn.dataset.filter;
                renderCashBook();
            }

            if (event.target.classList.contains('date-btn')) {
                const btn = event.target;
                event.stopPropagation();
                document.querySelectorAll('.date-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                currentDateRange = btn.dataset.date_range || btn.dataset.dateRange;

                const customContainer = document.getElementById('custom-date-container');
                if (currentDateRange === 'custom') {
                    customContainer.style.display = 'flex';
                } else {
                    customContainer.style.display = 'none';
                }
                renderCashBook();
            }

            // --- UNIFIED TABS & MOBILE NAVIGATION FIX ---
            const targetButton = event.target.closest('.tab-btn');
            if (targetButton) {
                const viewName = targetButton.getAttribute('data-view');

                // If it's a structural view tab change
                if (viewName) {
                    // 1. Remove active states across ALL navigation platforms (Sidebar + Mobile Bar)
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

                    // 2. Synchronize active state to both desktop and mobile buttons matching this view
                    document.querySelectorAll(`[data-view="${viewName}"]`).forEach(b => b.classList.add('active'));

                    // 3. Activate the matching target view container
                    const targetView = document.getElementById('view-' + viewName);
                    if (targetView) {
                        targetView.classList.add('active');
                    }

                    // ✨ THE FIX: Snap the window back to the top cleanly on tab switch
                    window.scrollTo({
                        top: 0,
                        behavior: 'instant' // Use 'instant' so it doesn't jarringly animate while DOM updates
                    });

                    // 4. Trigger lifecycle renders for targeted views
                    if (viewName === 'traders' || viewName === 'labor') {
                        // Ensure the view defaults nicely back to trader on tab transition
                        const traderRadio = document.querySelector('input[name="entity-type-toggle"][value="trader"]');
                        if (traderRadio) {
                            traderRadio.checked = true;
                            switchCombinedView('trader');
                        } else {
                            renderCombinedEntities();
                        }
                    }
                    if (viewName === 'inventory') renderInventoryLedger();
                    if (viewName === 'cashbook') populateTraderSelect();

                    // Automatically close the sidebar drawer on mobile/tablet after picking a view
                    const sidebar = document.querySelector("header");
                    if (sidebar && window.innerWidth <= 1024) {
                        sidebar.classList.remove("drawer-open");
                    }

                    return; // Stop execution since navigation was handled
                }

                // If it's the "More" button (has class .tab-btn but NO data-view)
                else {
                    const sidebar = document.querySelector("header");
                    if (sidebar) {
                        event.stopPropagation(); // Keep global handlers from closing it instantly
                        sidebar.classList.toggle("drawer-open");
                    }
                    return;
                }
            }
        });

        function startEdit(id) {
            const e = state.entries.find(x => x.id === id);
            if (!e) return;
            editingId = id;
            currentType = e.type;
            document.querySelector('[data-view="cashbook"]').click();
            updateTypeButtons();
            populateCategorySelect();
            document.getElementById('f-category').value = e.category;
            populateTraderSelect();
            document.getElementById('f-date').value = e.date;
            document.getElementById('f-desc').value = e.description || '';
            document.getElementById('f-status').value = e.status || 'Paid';
            document.getElementById('f-amount').value = e.amount;
            document.getElementById('f-notes').value = e.notes || '';
            if (document.getElementById('f-trader')) document.getElementById('f-trader').value = e.trader || '';

            if (e.qty || e.rate) {
                document.getElementById('calc-toggle').checked = true;
                document.getElementById('calc-fields').style.display = 'flex';
                document.getElementById('f-amount').readOnly = true;
                document.getElementById('f-amount').style.background = '#f4f1ea';
                document.getElementById('f-unit').value = e.unit || 'Units';
                document.getElementById('f-qty').value = e.qty || '';
                document.getElementById('f-rate').value = e.rate || '';
                document.getElementById('f-conv').value = e.convFactor || '';
                triggerUnitLabelUpdate();
            } else {
                document.getElementById('calc-toggle').checked = false;
                document.getElementById('calc-fields').style.display = 'none';
                document.getElementById('f-amount').readOnly = false;
                document.getElementById('f-amount').style.background = '';
            }
            document.getElementById('save-entry').textContent = 'Save changes';
            document.getElementById('cancel-edit').style.display = 'inline-block';
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function cancelEdit(event) {
            if (event) event.preventDefault(); // Prevents potential form submission interference

            editingId = null;

            // Reset UI elements
            const saveBtn = document.getElementById('save-entry');
            const cancelBtn = document.getElementById('cancel-edit');

            saveBtn.textContent = 'Add entry';
            cancelBtn.style.display = 'none';

            // Clear the form
            clearForm();

            console.log("Edit cancelled, form cleared."); // Check your browser console (F12) to see if this logs
        }

        function clearForm() {
            document.getElementById('f-date').value = todayStr();
            document.getElementById('f-desc').value = '';
            document.getElementById('f-status').value = 'Paid';
            document.getElementById('f-amount').value = '';
            document.getElementById('f-notes').value = '';

            // Explicitly reset dropdowns
            document.getElementById('f-category').selectedIndex = 0;
            document.getElementById('f-trader').selectedIndex = 0;

            // Reset calculator UI
            document.getElementById('calc-toggle').checked = false;
            document.getElementById('calc-fields').style.display = 'none';
            document.getElementById('f-amount').readOnly = false;
            document.getElementById('f-amount').style.background = '';

            // Attempt to clear drafts
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) { }
        }

        async function deleteEntry(id) {
            if (!await showModal("Are you sure you want to permanently delete this cashbook entry?", true, "Confirm Deletion")) return;
            state.entries = state.entries.filter(e => e.id !== id);
            await window.storage.set(STORAGE_KEY, JSON.stringify(state));
            render();
        }

        function updateTypeButtons() {
            document.querySelector('.sel-in').classList.toggle('selected', currentType === 'in');
            document.querySelector('.sel-out').classList.toggle('selected', currentType === 'out');
        }

        function suggestLastRate() {
            const currentCategory = document.getElementById('f-category').value;
            if (!currentCategory || !state.entries) return;
            const lastMatchingEntry = [...state.entries].reverse().find(e => e.category === currentCategory && e.rate);
            if (lastMatchingEntry) {
                document.getElementById('f-rate').value = lastMatchingEntry.rate;
            }
        }

        function initMenuDrawer() {
            const menuToggle = document.getElementById("menuToggleBtn");
            const sidebar = document.querySelector("header");
        
            if (!menuToggle || !sidebar) return;
        
            // Open/Close toggle assignment for hamburger icon click
            menuToggle.onclick = (e) => {
                e.stopPropagation();
                sidebar.classList.toggle("drawer-open");
            };
        
            // Close drawer panel if user taps empty space outside the menu
            document.addEventListener('click', (e) => {
                if (window.innerWidth <= 1024) {
                    const clickedMenu = menuToggle.contains(e.target);
                    const clickedSidebar = sidebar.contains(e.target);
        
                    if (!clickedSidebar && !clickedMenu) {
                        sidebar.classList.remove("drawer-open");
                    }
                }
            });
        }
        
        // Fallback cascade initialization to ensure it catches the engine lifecycle
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", initMenuDrawer);
        } else {
            initMenuDrawer();
        }

        async function init() {
            // Bind the segmented control radio switch triggers cleanly at start
            document.querySelectorAll('input[name="entity-type-toggle"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    switchCombinedView(e.target.value);
                });
            });

            document.getElementById('f-date').value = todayStr();
            populateCategorySelect();
            populateTraderSelect();
            loadDraft();

            try {
                const localRaw = localStorage.getItem(STORAGE_KEY);
                if (localRaw) {
                    const parsed = JSON.parse(localRaw);
                    state.openingBalance = Number(parsed.openingBalance) || 0;
                    state.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
                    state.traders = Array.isArray(parsed.traders) ? parsed.traders : [];
                    state.labor = Array.isArray(parsed.labor) ? parsed.labor : [];
                    state.stockAdjustments = Array.isArray(parsed.stockAdjustments) ? parsed.stockAdjustments : [];
                    document.getElementById('opening-input').value = state.openingBalance;
                    renderCombinedEntities();
                    render();
                }
            } catch (e) { }

            try {
                const res = await window.storage.get(STORAGE_KEY);
                if (res && res.value) {
                    const parsed = JSON.parse(res.value);
                    state.openingBalance = Number(parsed.openingBalance) || 0;
                    state.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
                    state.traders = Array.isArray(parsed.traders) ? parsed.traders : [];
                    state.labor = Array.isArray(parsed.labor) ? parsed.labor : [];
                    state.stockAdjustments = Array.isArray(parsed.stockAdjustments) ? parsed.stockAdjustments : [];
                    document.getElementById('opening-input').value = state.openingBalance;
                    renderCombinedEntities();
                    render();
                }
            } catch (e) { }

            const note = document.getElementById('save-note');
            if (note && note.textContent === 'Connecting to cloud database...') {
                note.textContent = 'App ready. Syncing updates in background...';
            }

            ['f-date', 'f-desc', 'f-category', 'f-status', 'f-amount', 'f-notes', 'f-trader', 'f-unit'].forEach(id => {
                const el = document.getElementById(id); if (el) el.addEventListener('input', saveDraft);
            });

            setInterval(async () => {
                try {
                    await window.storage.set(STORAGE_KEY, JSON.stringify(state));
                } catch (e) {
                    const n = document.getElementById('save-note');
                    if (n) n.textContent = 'Sync delayed. Checking network...';
                }
            }, 10000);
        }
        if (window.__partialsLoaded) { init(); } else { window.addEventListener('partialsLoaded', init); }