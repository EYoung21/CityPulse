import sys
import logging
from philly_pulse.server import _discover_storage_buckets
logging.basicConfig(level=logging.DEBUG)
print("Starting...")
buckets = _discover_storage_buckets()
print(f"Buckets: {buckets}")
