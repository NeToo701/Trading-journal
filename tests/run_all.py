"""Запускає всі перевірки: python3 tests/run_all.py
1) звірка JS-логіки з еталонами сервера (потрібен Node 18+),
2) браузерні перевірки основних функцій (потрібні Python-пакет playwright і Chromium: pip install playwright; playwright install chromium),
3) перевірки синхронізації на імітованій хмарі."""
import subprocess, sys
from pathlib import Path

here = Path(__file__).resolve().parent
steps = [("Звірка з еталонами (Node)", ["node", str(here / "parity.test.js")]),
         ("Браузер: основні функції", [sys.executable, str(here / "e2e_core.py")]),
         ("Браузер: синхронізація", [sys.executable, str(here / "e2e_sync.py")])]
bad = 0
for title, cmd in steps:
    print(f"\n######## {title}")
    r = subprocess.run(cmd)
    bad += r.returncode != 0
print("\nУСЕ ПРОЙШЛО" if not bad else f"\nПровалених блоків: {bad}")
sys.exit(1 if bad else 0)
