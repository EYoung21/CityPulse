import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
import json, os
from dotenv import load_dotenv

load_dotenv()
def get_stats():
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if cred_path and os.path.isfile(cred_path):
        cred = credentials.Certificate(cred_path)
    elif json_str:
        cred = credentials.Certificate(json.loads(json_str))
    else:
        raise RuntimeError("Firebase credentials are required to run test_agg.py directly")
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    
    stats = {}
    for status in ["passed", "blocked"]:
        agg = (
            db.collection("incidents")
            .where(filter=FieldFilter("inhibitor_status", "==", status))
            .count()
            .get()
        )
        stats[status] = agg[0][0].value
    return stats

if __name__ == "__main__":
    print(get_stats())
