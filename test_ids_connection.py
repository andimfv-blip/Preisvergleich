#!/usr/bin/env python3
"""
IDS-Connect Verbindungstest
Testet verschiedene URLs und zeigt, welche funktioniert
"""

import requests
import base64
from xml.dom import minidom

# HIER DEINE DATEN EINTRAGEN:
USERNAME = "119788"  # Deine Kundennummer oder Benutzername
PASSWORD = "zuGKi6GWqm"  # Dein Passwort
TEST_EAN = "4016705142040"  # Test-EAN (irgendeine)

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
    
    headers = {
        'Content-Type': 'application/xml',
        'Accept': 'application/xml',
        'Authorization': f'Basic {base64_auth}'
    }
    
    try:
        print(f"\n{'='*60}")
        print(f"Teste: {url}")
        print(f"{'='*60}")
        
        response = requests.post(
            url,
            data=xml_request.encode('utf-8'),
            headers=headers,
            timeout=10
        )
        
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            print("✅ ERFOLGREICH! Diese URL funktioniert!")
            print("\nAntwort:")
            try:
                # Versuche XML zu formatieren
                dom = minidom.parseString(response.text)
                print(dom.toprettyxml(indent="  "))
            except:
                print(response.text)
            return True
            
        elif response.status_code == 401:
            print("❌ Authentifizierung fehlgeschlagen (401)")
            print("   → Benutzername oder Passwort falsch")
            
        elif response.status_code == 404:
            print("❌ URL nicht gefunden (404)")
            print("   → Diese URL existiert nicht")
            
        else:
            print(f"❌ Fehler {response.status_code}")
            print(f"Antwort: {response.text[:200]}")
            
    except requests.exceptions.Timeout:
        print("❌ Timeout - Server antwortet nicht")
        
    except requests.exceptions.ConnectionError:
        print("❌ Verbindungsfehler - Server nicht erreichbar")
        
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
    
    for url in TEST_URLS:
        if test_ids_connection(url, USERNAME, PASSWORD, TEST_EAN):
            success = True
            print(f"\n{'='*60}")
            print("✅ GEFUNDEN! Diese URL funktioniert:")
            print(f"   {url}")
            print(f"{'='*60}")
            break
    
    if not success:
        print("\n" + "=" * 60)
        print("❌ Keine funktionierende URL gefunden!")
        print("\nMögliche Gründe:")
        print("1. Zugangsdaten falsch")
        print("2. IDS nicht für deinen Account aktiviert")
        print("3. Andere API-Endpunkte")
        print("\n→ Kontaktiere Fega & Schmitt Support!")
        print("   Tel: +49 981 8903-0")
        print("=" * 60)


if __name__ == "__main__":
    main()
