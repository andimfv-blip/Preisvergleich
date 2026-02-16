#!/usr/bin/env python3
"""
IDS-Connect Debug Test
Zeigt die vollständige API-Antwort
"""

import urllib.request
import urllib.error
import base64
import ssl

# DEINE DATEN:
URL = "https://shop.fega.de/scripts/clsAIShop.php"
USERNAME = "119788"
PASSWORD = "zuGKi6GWqm"  # Hier echtes Passwort eintragen
TEST_EAN = "4016705142040"  # Die EAN aus deinem Screenshot

def debug_request(url, username, password, ean):
    """Zeigt komplette Request und Response"""
    
    xml_request = f"""<?xml version="1.0" encoding="UTF-8"?>
<IDS version="1.0">
    <REQUEST>
        <ARTICLE_SEARCH>
            <EAN>{ean}</EAN>
        </ARTICLE_SEARCH>
    </REQUEST>
</IDS>"""
    
    auth_string = f"{username}:{password}"
    auth_bytes = auth_string.encode('ascii')
    base64_auth = base64.b64encode(auth_bytes).decode('ascii')
    
    ctx = ssl.create_default_context()
    
    print("=" * 70)
    print("DEBUG: IDS-CONNECT REQUEST")
    print("=" * 70)
    print(f"\nURL: {url}")
    print(f"Benutzername: {username}")
    print(f"EAN: {ean}")
    print(f"\n--- XML REQUEST ---")
    print(xml_request)
    print("--- END REQUEST ---\n")
    
    try:
        req = urllib.request.Request(
            url,
            data=xml_request.encode('utf-8'),
            headers={
                'Content-Type': 'application/xml',
                'Accept': 'application/xml',
                'Authorization': f'Basic {base64_auth}'
            }
        )
        
        with urllib.request.urlopen(req, context=ctx, timeout=15) as response:
            status_code = response.status
            response_text = response.read().decode('utf-8')
            
            print("=" * 70)
            print("RESPONSE")
            print("=" * 70)
            print(f"Status Code: {status_code}")
            print(f"\n--- XML RESPONSE ---")
            print(response_text)
            print("--- END RESPONSE ---\n")
            
            # Analysiere die Antwort
            print("=" * 70)
            print("ANALYSE")
            print("=" * 70)
            
            if '<DESCRIPTION>' in response_text:
                print("✅ Produktbeschreibung gefunden")
            else:
                print("❌ Keine Produktbeschreibung in Antwort")
                
            if '<NET_PRICE>' in response_text or '<PRICE>' in response_text:
                print("✅ Preis gefunden")
            else:
                print("❌ Kein Preis in Antwort")
                
            if '<AVAILABLE>' in response_text:
                print("✅ Verfügbarkeit gefunden")
            else:
                print("❌ Keine Verfügbarkeit in Antwort")
                
    except urllib.error.HTTPError as e:
        print(f"\n❌ HTTP ERROR: {e.code}")
        print(f"Antwort: {e.read().decode('utf-8')}")
        
    except Exception as e:
        print(f"\n❌ FEHLER: {e}")


if __name__ == "__main__":
    debug_request(URL, USERNAME, PASSWORD, TEST_EAN)
    
    print("\n" + "=" * 70)
    print("📋 KOPIERE DIE KOMPLETTE AUSGABE UND ZEIGE SIE MIR!")
    print("=" * 70)
