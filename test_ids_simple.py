#!/usr/bin/env python3
"""
IDS-Connect Verbindungstest (Nur Standard-Bibliotheken)
Testet verschiedene URLs
"""

import urllib.request
import urllib.error
import base64
import ssl

# HIER DEINE DATEN EINTRAGEN:
USERNAME = "119788"  # Deine Kundennummer oder Benutzername
PASSWORD = "zuGKi6GWqm"  # Dein Passwort
TEST_EAN = "4016705142040"  # Test-EAN

# URLs zum Testen
TEST_URLS = [
    "https://shop.fega.de/ids",
    "https://shop.fega.de/oci",
    "https://shop.fega.de/scripts/ids.php",
    "https://shop.fega.de/scripts/oci.php",
    "https://shop.fega.de/api/ids",
    "https://shop.fega.de/webservice/ids",
"https://shop.fega.de/scripts/clsAIShop.php",
]

def test_ids_connection(url, username, password, ean):
    """Testet IDS-Verbindung zu einer URL"""
    
    # XML-Request erstellen
    xml_request = f"""<?xml version="1.0" encoding="UTF-8"?>
<IDS version="1.0">
    <REQUEST>
        <ARTICLE_SEARCH>
            <EAN>{ean}</EAN>
        </ARTICLE_SEARCH>
    </REQUEST>
</IDS>"""
    
    # Basic Auth Header
    auth_string = f"{username}:{password}"
    auth_bytes = auth_string.encode('ascii')
    base64_auth = base64.b64encode(auth_bytes).decode('ascii')
    
    # SSL Context (für HTTPS)
    ctx = ssl.create_default_context()
    
    try:
        print(f"\n{'='*60}")
        print(f"Teste: {url}")
        print(f"{'='*60}")
        
        # Request erstellen
        req = urllib.request.Request(
            url,
            data=xml_request.encode('utf-8'),
            headers={
                'Content-Type': 'application/xml',
                'Accept': 'application/xml',
                'Authorization': f'Basic {base64_auth}'
            }
        )
        
        # Request ausführen
        with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
            status_code = response.status
            response_text = response.read().decode('utf-8')
            
            print(f"Status Code: {status_code}")
            
            if status_code == 200:
                print("✅ ERFOLGREICH! Diese URL funktioniert!")
                print("\nAntwort:")
                print(response_text[:500])  # Erste 500 Zeichen
                return True
            else:
                print(f"❌ Unerwarteter Status: {status_code}")
                return False
                
    except urllib.error.HTTPError as e:
        print(f"Status Code: {e.code}")
        
        if e.code == 401:
            print("❌ Authentifizierung fehlgeschlagen (401)")
            print("   → Benutzername oder Passwort falsch")
        elif e.code == 404:
            print("❌ URL nicht gefunden (404)")
            print("   → Diese URL existiert nicht")
        elif e.code == 403:
            print("❌ Zugriff verweigert (403)")
            print("   → Keine Berechtigung")
        else:
            print(f"❌ HTTP-Fehler {e.code}")
            
    except urllib.error.URLError as e:
        print(f"❌ Verbindungsfehler: {e.reason}")
        
    except Exception as e:
        print(f"❌ Fehler: {e}")
    
    return False


def main():
    print("=" * 60)
    print("IDS-CONNECT VERBINDUNGSTEST")
    print("Fega & Schmitt")
    print("=" * 60)
    print(f"\nBenutzername: {USERNAME}")
    print(f"Test-EAN: {TEST_EAN}")
    print(f"\nTeste {len(TEST_URLS)} URLs...\n")
    
    success = False
    working_url = None
    
    for url in TEST_URLS:
        if test_ids_connection(url, USERNAME, PASSWORD, TEST_EAN):
            success = True
            working_url = url
            break
    
    print("\n" + "=" * 60)
    if success:
        print("✅ GEFUNDEN! Diese URL funktioniert:")
        print(f"\n   {working_url}")
        print("\n📋 Trage diese URL in die Web-App ein:")
        print(f"   API URL: {working_url}")
        print(f"   Benutzername: {USERNAME}")
        print(f"   Passwort: [dein Passwort]")
    else:
        print("❌ Keine funktionierende URL gefunden!")
        print("\nMögliche Gründe:")
        print("1. Zugangsdaten falsch")
        print("2. IDS nicht für deinen Account aktiviert")
        print("3. Andere API-Endpunkte")
        print("\n→ Kontaktiere Fega & Schmitt Support!")
        print("   Tel: +49 981 8903-0")
        print("   E-Mail: info@fega-schmitt.de")
    print("=" * 60)


if __name__ == "__main__":
    main()
