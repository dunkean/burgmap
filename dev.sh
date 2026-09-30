#!/usr/bin/env bash
# Start the development server with auto-reload
exec python -m uvicorn town_generator.webapp.app:app --host 127.0.0.1 --port 9000 --reload
