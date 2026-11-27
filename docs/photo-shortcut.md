# Find places from iPhone photos

The journal launches an Apple Shortcut named **hayiti photo locations** with the selected trip dates. Until a signed shortcut is distributed, create it once in Shortcuts using the actions below.

1. Create a shortcut named **hayiti photo locations**. Use **Get Dictionary from Input** on Shortcut Input. Read the text values for the keys `start` and `end`.
2. Convert those dates to local midnight in the trip's time zone. Use **Adjust Date** to add one day to the end. Use **Find Photos** filtered by Date Taken for that interval. Allow Photos access when prompted. Limited access searches only the permitted photos.
3. Begin a list of text lines with `hayiti-photo-locations/1`. **Repeat with Each** photo. Get its Date Taken and Location using **Get Details of Images**. Format the capture date and time in the trip's time zone using the custom formats `yyyy-MM-dd` and `HH:mm`. Get Latitude and Longitude from Location. Append a line of the form `date|time|latitude|longitude`. Use decimal points for coordinates. Leave both coordinate fields empty when location is missing.
4. **Combine Text** with new lines, **Set Name** to `photo-locations.txt`, then **Save File**. The file contains precise locations and times. Save it privately. No images or photo identifiers are included.

In the journal, open **Sources and import → Files → Find places from my photos**. After the shortcut finishes, select its text file under **Files**, review the places and save the ones you want. The journal checks the trip dates again, skips missing coordinates, and groups nearby photos taken within 30 minutes and 75 meters of the first photo in a visit. One nearby timed stop can receive photo evidence. When several stops could match, the proposed location stays separate.

A fictional export looks like this:

```text
hayiti-photo-locations/1
2026-06-01|09:05|51.92|4.48
2026-06-01|09:07|51.9201|4.48
```
