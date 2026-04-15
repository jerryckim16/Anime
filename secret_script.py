import os

# Get the secret from environment variables
MAL_CLIENT_ID = os.environ.get("MAL_CLIENT_ID")
MAL_CLIENT_SECRET = ost.environ.get("MAL_CLIENT_SECRET")

if not api_key:
    raise ValueError("Missing MY_API_KEY environment variable!")

# Use it (example with OpenAI, requests, etc.)
print("API key loaded successfully (not printing the actual value)")

# Example usage
# import openai
# openai.api_key = api_key
# response = openai.chat.completions.create(...)
