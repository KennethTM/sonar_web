document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const loadingIndicator = document.getElementById('loading-indicator');
    const controls = document.getElementById('controls');
    const mapContainer = document.getElementById('map');
    const colorSelect = document.getElementById('color-select');
    const downloadCsvBtn = document.getElementById('download-csv');

    let map = null;
    let processedData = [];
    let mapMarkers = [];
    let legend = null;

    // --- File Handling ---
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            handleFile(file);
        }
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) {
            handleFile(file);
        }
    });

    function handleFile(file) {
        console.log(`File selected: ${file.name}`);
        loadingIndicator.style.display = 'block';
        controls.style.display = 'none';
        mapContainer.style.display = 'none';

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                processedData = parseSonarFile(e.target.result, file.name);
                console.log(`Successfully parsed ${processedData.length} data points.`);
                displayData();
            } catch (error) {
                console.error('Failed to parse file:', error);
                alert(`Error parsing file: ${error.message}`);
            } finally {
                loadingIndicator.style.display = 'none';
            }
        };
        reader.onerror = (e) => {
            console.error('FileReader error:', e);
            alert('Failed to read file.');
            loadingIndicator.style.display = 'none';
        };
        reader.readAsArrayBuffer(file);
    }

    // --- Sonar Parsing Logic ---
    function parseSonarFile(arrayBuffer, fileName) {
        const view = new DataView(arrayBuffer);
        const extension = fileName.split('.').pop().toLowerCase();
        const isSl3 = extension === 'sl3';

        const fileHeaderSize = 8;
        const data = [];

        // File header
        const version = view.getInt16(0, true);
        const deviceId = view.getInt16(2, true);
        console.log(`File Version: ${version}, Device ID: ${deviceId}`);

        let position = fileHeaderSize;
        if (position >= arrayBuffer.byteLength) return [];

        // Get start time from the first frame's hardware_time, which is used as a base for all timestamps
        const firstFrameHardWareTimeOffset = isSl3 ? 40 : 60;
        const startTime = view.getUint32(position + firstFrameHardWareTimeOffset, true);

        while (position < arrayBuffer.byteLength) {
            const frameHeaderSize = isSl3 ? 168 : 144;
            if (position + frameHeaderSize > arrayBuffer.byteLength) {
                console.log('Reached end of file (not enough data for a full header).');
                break;
            }

            const frameSizeSlice = isSl3 ? [8, 2] : [28, 2];
            const frameSize = view.getUint16(position + frameSizeSlice[0], true);

            if (frameSize === 0 || position + frameSize > arrayBuffer.byteLength) {
                 console.log('Invalid frame size or incomplete frame, stopping.');
                 break;
            }

            const frameData = parseFrame(view, position, isSl3, startTime);
            if (frameData && frameData.water_depth > 0) {
                 data.push(frameData);
            }

            position += frameSize;
        }

        return data;
    }

    function parseFrame(view, position, isSl3, startTime) {
        const FEET_TO_METERS = 0.3048;
        const KNOTS_TO_MPS = 0.514444;

        const frame = {};
        let secondsOffset;
        let surveyType;

        if (isSl3) {
            surveyType = view.getUint16(position + 12, true);
            if (surveyType !== 0) return null; // Filter for primary channel

            frame.min_range = view.getFloat32(position + 20, true) * FEET_TO_METERS;
            frame.max_range = view.getFloat32(position + 24, true) * FEET_TO_METERS;
            frame.water_depth = view.getFloat32(position + 48, true) * FEET_TO_METERS;
            frame.x = view.getInt32(position + 92, true);
            frame.y = view.getInt32(position + 96, true);
            secondsOffset = view.getUint32(position + 124, true) / 1000; // Convert ms to s
            frame.frame_size = view.getUint16(position + 8, true);
            frame.header_size = 168;
        } else { // sl2
            surveyType = view.getUint16(position + 32, true);
            if (surveyType !== 0) return null; // Filter for primary channel

            frame.min_range = view.getFloat32(position + 40, true) * FEET_TO_METERS;
            frame.max_range = view.getFloat32(position + 44, true) * FEET_TO_METERS;
            frame.water_depth = view.getFloat32(position + 64, true) * FEET_TO_METERS;
            frame.x = view.getInt32(position + 108, true);
            frame.y = view.getInt32(position + 112, true);
            // The python reference divides seconds by 1000 for all formats, so we apply it here too.
            secondsOffset = view.getUint32(position + 140, true) / 1000; // Convert ms to s
            frame.frame_size = view.getUint16(position + 28, true);
            frame.header_size = 144;
        }

        // Ignore points with no coordinates
        if (frame.x === 0 || frame.y === 0) return null;

        // Coordinate conversion
        frame.longitude = frame.x / 6356752.3142 * (180 / Math.PI);
        frame.latitude = (2 * Math.atan(Math.exp(frame.y / 6356752.3142)) - (Math.PI / 2)) * (180 / Math.PI);

        // Timestamp calculation based on the python reference
        const timestampInSeconds = startTime + secondsOffset;
        frame.timestamp = new Date(timestampInSeconds * 1000);

        // Sonar signal data
        const signalDataStart = position + frame.header_size;
        const signalDataEnd = position + frame.frame_size;
        const signalData = new Uint8Array(view.buffer, signalDataStart, signalDataEnd - signalDataStart);

        if (frame.max_range <= frame.min_range) return null; // Avoid division by zero

        const bottom_index = Math.floor((signalData.length / (frame.max_range - frame.min_range)) * frame.water_depth);

        if (bottom_index < 0 || bottom_index >= signalData.length) return null;

        frame.bottom_density_1 = signalData[bottom_index];

        const avg10 = getAverage(signalData, bottom_index, 10);
        frame.bottom_density_10 = avg10.avg;

        const avg100 = getAverage(signalData, bottom_index, 100);
        frame.bottom_density_100 = avg100.avg;

        return frame;
    }

    function getAverage(array, index, count) {
        let sum = 0;
        let actualCount = 0;
        for (let i = 0; i < count; i++) {
            const currentIndex = index + i;
            if (currentIndex < array.length) {
                sum += array[currentIndex];
                actualCount++;
            }
        }
        return { sum, avg: actualCount > 0 ? sum / actualCount : 0, count: actualCount };
    }

    // --- Map & Display Logic ---
    function displayData() {
        if (!processedData || processedData.length === 0) {
            alert('No data points were extracted. The file might be empty, corrupted, or in an unsupported format.');
            return;
        }

        controls.style.display = 'flex';
        mapContainer.style.display = 'block';

        if (!map) {
            map = L.map('map', { preferCanvas: true }).setView([processedData[0].latitude, processedData[0].longitude], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 20
            }).addTo(map);

            legend = L.control({position: 'bottomright'});

            legend.onAdd = function (map) {
                this._div = L.DomUtil.create('div', 'info legend');
                this.update();
                return this._div;
            };

            legend.update = function (colorScale, min, max, attributeName) {
                this._div.innerHTML = ''; // Clear previous legend
                if (!colorScale) {
                    return;
                }

                const steps = 10;
                let gradientHtml = '';
                for (let i = 0; i < steps; i++) {
                    const value = min + (max - min) * (i / (steps - 1));
                    gradientHtml += `<i style="background:${colorScale(value)}"></i>`;
                }

                this._div.innerHTML =
                    `<h4>${attributeName}</h4>` +
                    `<div class="legend-gradient">${gradientHtml}</div>` +
                    `<div class="legend-labels"><span>${min.toFixed(1)}</span><span>${max.toFixed(1)}</span></div>`;
            };

            legend.addTo(map);

        } else {
            map.setView([processedData[0].latitude, processedData[0].longitude], 15);
        }

        updateMapColors();
    }

    function updateMapColors() {
        // Clear existing markers
        mapMarkers.forEach(marker => marker.remove());
        mapMarkers = [];

        const colorAttribute = colorSelect.value;
        const attributeName = colorSelect.options[colorSelect.selectedIndex].text;
        
        let min = Infinity;
        let max = -Infinity;
        for (const p of processedData) {
            const v = p[colorAttribute];
            if (v < min) min = v;
            if (v > max) max = v;
        }

        const viridisHex = ['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'].reverse();
        const viridisRgb = viridisHex.map(hex => {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
        });

        const colorScale = (value) => {
            if (max === min) return `rgb(${viridisRgb[0][0]}, ${viridisRgb[0][1]}, ${viridisRgb[0][2]})`;
            const t = Math.max(0, Math.min(1, (value - min) / (max - min)));

            const colorIndex = t * (viridisRgb.length - 1);
            const i = Math.floor(colorIndex);
            const j = Math.ceil(colorIndex);
            const frac = colorIndex - i;

            if (i === j) {
                return `rgb(${viridisRgb[i][0]}, ${viridisRgb[i][1]}, ${viridisRgb[i][2]})`;
            }

            const r = Math.round(viridisRgb[i][0] + frac * (viridisRgb[j][0] - viridisRgb[i][0]));
            const g = Math.round(viridisRgb[i][1] + frac * (viridisRgb[j][1] - viridisRgb[i][1]));
            const b = Math.round(viridisRgb[i][2] + frac * (viridisRgb[j][2] - viridisRgb[i][2]));

            return `rgb(${r}, ${g}, ${b})`;
        };

        legend.update(colorScale, min, max, attributeName);

        processedData.forEach(point => {
            const marker = L.circleMarker([point.latitude, point.longitude], {
                radius: 5,
                fillColor: colorScale(point[colorAttribute]),
                color: colorScale(point[colorAttribute]),
                weight: 0.5,
                opacity: 1,
                fillOpacity: 0.8
            }).addTo(map);

            marker.bindPopup(
                `<b>Water Depth:</b> ${point.water_depth.toFixed(2)} m<br>\n                <b>Density (1px):</b> ${point.bottom_density_1.toFixed(1)}<br>\n                <b>Density (10px):</b> ${point.bottom_density_10.toFixed(1)}<br>\n                <b>Density (100px):</b> ${point.bottom_density_100.toFixed(1)}<br>`
            );

            mapMarkers.push(marker);
        });
    }

    colorSelect.addEventListener('change', updateMapColors);

    // --- CSV Export ---
    downloadCsvBtn.addEventListener('click', () => {
        if (processedData.length === 0) {
            alert('No data to export.');
            return;
        }

        const headers = ['latitude', 'longitude', 'timestamp', 'water_depth', 'bottom_density_1', 'bottom_density_10', 'bottom_density_100'];
        let csvContent = 'data:text/csv;charset=utf-8,' + headers.join(',') + '\n';

        processedData.forEach(row => {
            const values = headers.map(header => {
                const value = row[header];
                switch (header) {
                    case 'latitude':
                    case 'longitude':
                        return value.toFixed(7);
                    case 'water_depth':
                        return value.toFixed(2);
                    case 'bottom_density_1':
                    case 'bottom_density_10':
                    case 'bottom_density_100':
                        return value.toFixed(1);
                    case 'timestamp':
                        return value.toISOString();
                    default:
                        return value;
                }
            });
            csvContent += values.join(',') + '\n';
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', 'sonar_data.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
});