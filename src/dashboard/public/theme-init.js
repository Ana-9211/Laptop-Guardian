try { var t = localStorage.getItem('lg-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* storage unavailable: fall back to the system theme */ }
