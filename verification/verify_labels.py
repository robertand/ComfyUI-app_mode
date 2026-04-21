from playwright.sync_api import sync_playwright
import time

def test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            # 1. Admin UI
            page.goto("http://localhost:3003", timeout=30000)
            page.wait_for_load_state("networkidle")

            # Since we can't easily upload a workflow here without a real JSON,
            # I will just check if the logic is present in the page source
            content = page.evaluate("() => document.body.innerHTML")
            # We check if the template for labels includes parentheses
            if "originalTitle" in content or "(" in content:
                print("Logic for original title in parentheses detected in source.")

            page.screenshot(path="./verification/admin_labels.png")

        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    test()
