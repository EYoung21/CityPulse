import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate('.secrets/firebase-service-account.json')
firebase_admin.initialize_app(cred)
db = firestore.client()

docs = db.collection('incidents').order_by('reported_at', direction=firestore.Query.DESCENDING).limit(5).stream()

for doc in docs:
    data = doc.to_dict()
    print("KEYS:", data.keys())
    print("CITY:", data.get('city'))
