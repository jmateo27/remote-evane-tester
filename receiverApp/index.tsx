import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { LineChart, Grid } from 'react-native-svg-charts';
import * as scale from 'd3-scale';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';
const MAX_GRAPH_SECONDS = 10;

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const baselineRef = useRef<number | null>(null);
  const scanTimerRef = useRef<NodeJS.Timer | null>(null);

  // Latest state refs
  const baselineStateRef = useRef<number | null>(null);
  const vrefStateRef = useRef<number | null>(null);
  const isLoggingRef = useRef(false);
  const loggingStartTimeRef = useRef<number | null>(null);
  const logEntriesRef = useRef<string[]>([]);

  // State variables for UI
  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);
  const [valueHistory, setValueHistory] = useState<{ timestamp: number; value: number }[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [scanTime, setScanTime] = useState<number>(0);
  const [isLogging, setIsLogging] = useState(false);
  const [loggingStartTime, setLoggingStartTime] = useState<number | null>(null);
  const [lastSavedFileUri, setLastSavedFileUri] = useState<string | null>(null);

  // Update refs when states change
  useEffect(() => { baselineStateRef.current = Baseline; }, [Baseline]);
  useEffect(() => { vrefStateRef.current = Vref; }, [Vref]);
  useEffect(() => { isLoggingRef.current = isLogging; }, [isLogging]);
  useEffect(() => { loggingStartTimeRef.current = loggingStartTime; }, [loggingStartTime]);

  function updateBaseline(value: number) {
    baselineRef.current = value;
    setBaseline(value);
  }

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version < 31) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const grantedScan = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN
        );
        const grantedConnect = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        );
        return (
          grantedScan === PermissionsAndroid.RESULTS.GRANTED &&
          grantedConnect === PermissionsAndroid.RESULTS.GRANTED
        );
      }
    }
    return true;
  }

  async function startScanAndConnect() {
    const permission = await requestPermissions();
    if (!permission) return;

    setScanTime(0);
    setConnecting(true);

    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    scanTimerRef.current = setInterval(() => setScanTime((s) => s + 1), 1000);

    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);
        setConnecting(false);
        return;
      }

      if (device?.name === TARGET_NAME) {
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);

        try {
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();
          setConnectedDevice(connected);
          monitorNotifications(connected);
          ToastAndroid.show(`Connected in ${scanTime} seconds.`, ToastAndroid.SHORT);
          connected.onDisconnected(disconnect);
        } catch {
          ToastAndroid.show('Connection failed', ToastAndroid.SHORT);
        }

        setConnecting(false);
        setScanTime(0);
      }
    });
  }

  function monitorNotifications(device: Device) {
    device.monitorCharacteristicForService(SERVICE_UUID, CHARACTERISTIC_UUID, (err, characteristic) => {
      if (err || !characteristic?.value) return;

      const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
      const isValid = /^[BV]-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(decoded);
      if (!isValid) return;

      const type = decoded[0];
      const [firstStr, secondStr] = decoded.slice(1).split(',');
      const first = parseFloat(firstStr);
      const second = parseFloat(secondStr);
      if (isNaN(first) || isNaN(second)) return;

      setReading(second);

      if (type === 'B') updateBaseline(first);
      else if (type === 'V') setVref(first);

      if (baselineRef.current !== null) {
        const val = second - baselineRef.current;
        setValue(val);

        const now = Date.now();
        setValueHistory((prev) => {
          const filtered = prev.filter((d) => now - d.timestamp < MAX_GRAPH_SECONDS * 1000);
          return [...filtered, { timestamp: now, value: val }];
        });

        if (isLoggingRef.current && loggingStartTimeRef.current !== null) {
          const timeSinceStart = ((now - loggingStartTimeRef.current) / 1000).toFixed(3);
          const baselineStr = baselineStateRef.current !== null ? baselineStateRef.current.toFixed(6) : '';
          const vrefStr = vrefStateRef.current !== null ? vrefStateRef.current.toFixed(6) : '';
          const readingStr = second.toFixed(6);
          const valueStr = val.toFixed(6);

          const entry = `${timeSinceStart},${baselineStr},${vrefStr},${readingStr},${valueStr}`;
          logEntriesRef.current.push(entry);
        }
      }
    });
  }

  async function disconnect() {
    try {
      await connectedDevice?.cancelConnection();
    } catch {}
    setConnectedDevice(null);
    setBaseline(null);
    setVref(null);
    setReading(null);
    setValue(null);
    setValueHistory([]);
    setIsLogging(false);
    setLoggingStartTime(null);
    logEntriesRef.current = [];
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
  }

  async function startLogging() {
    if (isLoggingRef.current) {
      ToastAndroid.show('Already logging', ToastAndroid.SHORT);
      return;
    }
    const now = new Date();
    setLoggingStartTime(now.getTime());
    setIsLogging(true);

    logEntriesRef.current = [];

    const dateStr = now.toLocaleDateString().replaceAll('/', '-');
    const timeStr = now.toLocaleTimeString();
    const baselineStr = baselineStateRef.current !== null ? baselineStateRef.current.toFixed(6) : 'Unknown';

    // Add header rows as separate key,value cells
    logEntriesRef.current.push(`Date,${dateStr}`);
    logEntriesRef.current.push(`Start Time,${timeStr}`);
    logEntriesRef.current.push(`Baseline (V),${baselineStr}`);
    logEntriesRef.current.push(''); // Blank line
    logEntriesRef.current.push('Time (s),Baseline (V),Vref (V),Reading (V),Value (V)');

    ToastAndroid.show('Started logging', ToastAndroid.SHORT);
  }

  async function stopLogging() {
    if (!isLoggingRef.current) {
      ToastAndroid.show('Not currently logging', ToastAndroid.SHORT);
      return;
    }
    setIsLogging(false);

    if (logEntriesRef.current.length <= 5) {
      ToastAndroid.show('No data logged.', ToastAndroid.SHORT);
      return;
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const logDir = FileSystem.documentDirectory + 'logs/';
    await FileSystem.makeDirectoryAsync(logDir, { intermediates: true });

    let n = 1;
    let fileUri = `${logDir}vaneTestData_${dateStr}_${n}.csv`;
    while ((await FileSystem.getInfoAsync(fileUri)).exists) {
      n++;
      fileUri = `${logDir}vaneTestData_${dateStr}_${n}.csv`;
    }

    try {
      await FileSystem.writeAsStringAsync(fileUri, logEntriesRef.current.join('\n'));
      setLastSavedFileUri(fileUri);
      ToastAndroid.show(`CSV saved: ${fileUri}`, ToastAndroid.SHORT);
    } catch (e) {
      ToastAndroid.show('Failed to save CSV file.', ToastAndroid.SHORT);
    }
  }

  async function shareLatestCSV() {
    if (lastSavedFileUri && (await Sharing.isAvailableAsync())) {
      try {
        await Sharing.shareAsync(lastSavedFileUri);
      } catch {
        ToastAndroid.show('Sharing failed', ToastAndroid.SHORT);
      }
    } else {
      ToastAndroid.show('No CSV available to share.', ToastAndroid.SHORT);
    }
  }

  useEffect(() => {
    return () => {
      bleManager.destroy();
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    };
  }, []);

  const now = Date.now();
  const graphData = valueHistory
    .filter((d) => now - d.timestamp < MAX_GRAPH_SECONDS * 1000)
    .map((d) => ({ y: (now - d.timestamp) / 1000, x: d.value }));

  const maxX = Math.max(0.2, ...graphData.map((d) => d.x));

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Remote Vane Tester</Text>

      {connecting && (
        <>
          <ActivityIndicator size="large" color="#0000ff" style={{ marginBottom: 10 }} />
          <Text>Scanning... {scanTime}s</Text>
          <Button title="Retry" onPress={startScanAndConnect} />
        </>
      )}

      {!connecting && !connectedDevice && (
        <>
          <Text>Not connected</Text>
          <Button title="Connect" onPress={startScanAndConnect} />
        </>
      )}

      {connectedDevice && (
        <>
          <Text style={styles.connectedText}>Connected to {connectedDevice.name}</Text>
          <View style={styles.dataContainer}>
            <Text style={styles.dataText}>Baseline: {Baseline !== null ? Baseline.toFixed(6) : '...'}</Text>
            <Text style={styles.dataText}>Vref: {Vref !== null ? Vref.toFixed(6) : '...'}</Text>
            <Text style={styles.dataText}>Reading: {Reading !== null ? Reading.toFixed(6) : '...'}</Text>
            <Text style={styles.dataText}>Value: {Value !== null ? Value.toFixed(6) : '...'}</Text>
          </View>

          <View style={{ marginTop: 20, height: 200, padding: 10 }}>
            <LineChart
              style={{ flex: 1 }}
              data={graphData}
              yAccessor={({ item }) => item.y}
              xAccessor={({ item }) => item.x}
              svg={{ stroke: 'rgb(34, 128, 176)', strokeWidth: 2 }}
              contentInset={{ top: 10, bottom: 10 }}
              xMin={-0.1}
              xMax={maxX}
              yMin={0}
              yMax={MAX_GRAPH_SECONDS}
              scale={scale.scaleLinear}
              numberOfTicks={MAX_GRAPH_SECONDS}
            >
              <Grid direction={Grid.Direction.HORIZONTAL} />
            </LineChart>
          </View>

          <View style={{ marginTop: 20 }}>
            {!isLogging ? (
              <Button title="Start Logging" onPress={startLogging} />
            ) : (
              <>
                <Button title="Stop Logging" onPress={stopLogging} />
                <Text style={{ marginTop: 10 }}>
                  Logging... {((Date.now() - (loggingStartTime ?? 0)) / 1000).toFixed(1)} s
                </Text>
              </>
            )}

            <View style={{ marginTop: 10 }}>
              <Button title="Share CSV" onPress={shareLatestCSV} />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  connectedText: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  dataContainer: {
    marginTop: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#f9f9f9',
  },
  dataText: { fontSize: 16, marginBottom: 8, fontFamily: 'monospace' },
});
