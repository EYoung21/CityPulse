import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone, timedelta

cred = credentials.Certificate('.secrets/firebase-service-account.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

since = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
docs = db.collection('extractions').order_by('reported_at', direction=firestore.Query.DESCENDING).limit(100).stream()

for doc in docs:
    data = doc.to_dict()
    if data.get('city') == 'nyc' and data.get('llm_relevant') == True:
        print("NYC EXTR:", data.get('raw_text'))
        print("  LOC:", data.get('llm_location_text'))
        print("  GEOCODE_STATUS:", data.get('geocode_status'))

