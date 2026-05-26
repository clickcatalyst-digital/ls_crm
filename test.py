import requests
import os

OPENROUTER_API_KEY = "sk-or-v1-.."  # paste your key directly here to bypass .env issues

r = requests.post(
    "https://openrouter.ai/api/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "deepseek/deepseek-v4-flash",
        # "model": "google/gemma-4-31b-it",
        "messages": [{"role": "user", "content": "Reply with just the word: working"}]
    }
)

print("Status:", r.status_code)
print("Body:", r.json())