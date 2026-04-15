import os

# Get the credentials from environment variables
MAL_CLIENT_ID = os.environ.get("MAL_CLIENT_ID")
MAL_CLIENT_SECRET = os.environ.get("MAL_CLIENT_SECRET")

if not MAL_CLIENT_ID or not MAL_CLIENT_SECRET:
    raise ValueError(
        "Missing MAL_CLIENT_ID or MAL_CLIENT_SECRET environment variable!"
    )

print("MAL credentials loaded successfully (not printing the actual values)")
