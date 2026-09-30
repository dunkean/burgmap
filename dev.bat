@echo off
REM Start the development server with auto-reload
python -m uvicorn town_generator.webapp.app:app --host 127.0.0.1 --port 9000 --reload
