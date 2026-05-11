import firebase_admin
from firebase_admin import credentials, firestore, storage
import os
import time

def main():
    print("Starting audio backfill...")
    cred_path = os.path.expanduser("~/.secrets/firebase-service-account.json")
    if not os.path.exists(cred_path):
        cred_path = "/opt/citypulse-backfill/.secrets/firebase-service-account.json"
    
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred, {
        'storageBucket': 'phlpulse.firebasestorage.app'
    })
    
    db = firestore.client()
    bucket = storage.bucket()
    
    raw_dir = "/opt/citypulse-backfill/audio_clips_raw"
    clips_dir = "/opt/citypulse-backfill/audio_clips"
    
    # We will process incidents missing audio_url
    print("Querying Firestore for incidents without audio_url...")
    # Fetch all incidents from the last few days (descending by reported_at)
    docs = db.collection('incidents').order_by('reported_at', direction=firestore.Query.DESCENDING).limit(10000).stream()
    
    count_updated = 0
    count_not_found_on_disk = 0
    count_no_clip_id = 0
    
    for doc in docs:
        d = doc.to_dict()
        if d.get('audio_url'):
            continue
            
        # Prioritize audio_clip, fallback to raw_audio_clip
        clip_id = d.get('audio_clip') or d.get('raw_audio_clip')
        
        if not clip_id:
            count_no_clip_id += 1
            continue
            
        file_path = os.path.join(raw_dir, f"{clip_id}.wav")
        if not os.path.exists(file_path):
            file_path = os.path.join(clips_dir, f"{clip_id}.wav")
            
        if not os.path.exists(file_path):
            count_not_found_on_disk += 1
            continue
            
        # Upload to Storage
        blob_path = f"audio/{clip_id}.wav"
        blob = bucket.blob(blob_path)
        
        print(f"Uploading {file_path} to {blob_path}...")
        blob.upload_from_filename(file_path, content_type="audio/wav")
        
        # Public URL
        public_url = f"https://storage.googleapis.com/{bucket.name}/{blob_path}"
        
        # Update Firestore
        doc.reference.update({'audio_url': public_url})
        count_updated += 1
        print(f"Updated {d.get('id')} with audio_url {public_url}")

    print(f"\nBackfill complete!")
    print(f"Updated: {count_updated}")
    print(f"Clip not found on disk: {count_not_found_on_disk}")
    print(f"Missing clip ID in Firestore: {count_no_clip_id}")

if __name__ == "__main__":
    main()
