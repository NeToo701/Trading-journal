#!/bin/sh
# Локальний сервер для перевірок: ./tests/serve.sh [порт]
cd "$(dirname "$0")/.." && exec python3 -m http.server "${1:-8765}" --bind 127.0.0.1
