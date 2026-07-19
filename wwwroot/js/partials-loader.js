
        // Partial loader: fetches partial HTML fragments into their view containers and signals readiness.
        const parts = [
            {id: 'view-dashboard', path: './partials/dashboard.html'},
            {id: 'view-cashbook', path: './partials/cashbook.html'},
            {id: 'view-inventory', path: './partials/stockledger.html'},
            {id: 'view-traders', path: './partials/parties.html'},
            {id: 'view-summary', path: './partials/summary.html'},
        ];

        for (const p of parts) {
            try {
                const el = document.getElementById(p.id);
                if (!el) continue;
                if (el.innerHTML && el.innerHTML.trim().length > 0) continue; // already present
                const res = await fetch(p.path);
                if (!res.ok) continue;
                const txt = await res.text();
                el.innerHTML = txt;
            } catch (e) {
                console.error('Failed loading partial', p.path, e);
            }
        }

        window.__partialsLoaded = true;
        window.dispatchEvent(new Event('partialsLoaded'));