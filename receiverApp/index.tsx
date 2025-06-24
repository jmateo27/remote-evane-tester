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
import { LineChart, Grid, XAxis, YAxis } from 'react-native-svg-charts';
import * as scale from 'd3-scale';
import * as FileSystem from 'expo-file-system';

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';
const MAX_GRAPH_SECONDS = 10;

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const baselineRef = useRef<number | null>(null);
  const scanTimerRef = useRef<NodeJS.Timer | null>(null);

  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [scanTime, setScanTime] = useState<number>(0);

  const [graphData, setGraphData] = useState<{ x: number; y: number; timestamp: number }[]>([]);
  const maxXRef = useRef(0.5);

  const [isLogging, setIsLogging] = useState(false);
  const [loggingStartTime, setLoggingStartTime] = useState<number | null>(null);
  const [logEntries, setLogEntries] = useState<string[]>([]);

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
    device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      (_, characteristic) => {
        const decoded = Buffer.from(characteristic?.value ?? '', 'base64').toString('utf-8');
        const match = decoded.match(/^([BV]),(-?\d+(\.\d+)?),(-?\d+(\.\d+)?)$/);
        if (!match) return;

        const type = match[1];
        const first = parseFloat(match[2]);
        const second = parseFloat(match[4]);
        setReading(second);

        if (type === 'B') updateBaseline(first);
        else setVref(first);

        if (baselineRef.current !== null) {
          const value = second - baselineRef.current;
          setValue(value);

          const now = Date.now();
          if (value > maxXRef.current) maxXRef.current = value;
          else maxXRef.current = maxXRef.current * 0.95 + value * 0.05;

          setGraphData((data) => {
            const filtered = data.filter((d) => now - d.timestamp < MAX_GRAPH_SECONDS * 1000);
            const oldestTimestamp = filtered[0]?.timestamp ?? now;
            const updatedData = [...filtered, { x: value, y: (now - oldestTimestamp) / 1000, timestamp: now }];
            return updatedData.slice(-100);
          });

          if (isLogging && loggingStartTime !== null) {
            const timeSinceStart = ((now - loggingStartTime) / 1000).toFixed(3);
            setLogEntries((prev) => [...prev, `${timeSinceStart},${value.toFixed(6)}`]);
          }
        }
      }
    );
  }

  function disconnect() {
    connectedDevice?.cancelConnection();
    setConnectedDevice(null);
    setBaseline(null);
    setVref(null);
    setReading(null);
    setValue(null);
    setConnecting(false);
    setGraphData([]);
    maxXRef.current = 0.5;
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
  }

  async function startLogging() {
    const now = new Date();
    setLoggingStartTime(now.getTime());
    const dateStr = now.toLocaleDateString().replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString();
    const header = `Date: ${dateStr}\nStart Time: ${timeStr}\nBaseline(V): ${Baseline ?? 'Unknown'}\n\nTime(s),Reading(V)`;
    setLogEntries([header]);
    setIsLogging(true);
  }

  async function stopLogging() {
    setIsLogging(false);
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
    await FileSystem.writeAsStringAsync(fileUri, logEntries.join('\n'));
    ToastAndroid.show('CSV file saved', ToastAndroid.SHORT);
  }

  // Prepare graph data with y inverted to increase downward (as before)
  const filteredGraphData = graphData
    .filter((item) => item.y !== undefined)
    .map(({ x, y }) => ({ x, y: MAX_GRAPH_SECONDS - y }));

  const maxX = Math.max(0.5, maxXRef.current * 1.1);
  const yTicks = Array.from({ length: MAX_GRAPH_SECONDS + 1 }, (_, i) => i);

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
            <Text style={styles.dataText}>
              Baseline: {Baseline !== null ? Baseline.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Vref: {Vref !== null ? Vref.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Reading: {Reading !== null ? Reading.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Value: {Value !== null ? Value.toFixed(6) : '...'}
            </Text>
          </View>

          <View style={{ height: 240, flexDirection: 'row', paddingHorizontal: 10, marginTop: 20 }}>
            {/* Y Axis */}
            <View style={{ marginRight: 5 }}>
              <YAxis
                style={{ height: 200 }}
                data={yTicks}
                numberOfTicks={MAX_GRAPH_SECONDS + 1}
                formatLabel={(value) => `${value}`}
                contentInset={{ top: 10, bottom: 10 }}
                svg={{ fontSize: 10, fill: 'black' }}
                min={0}
                max={MAX_GRAPH_SECONDS}
                scale={scale.scaleLinear}
              />
              <Text
                style={{
                  fontSize: 12,
                  textAlign: 'center',
                  marginTop: 5,
                  width: 200,
                  alignSelf: 'center',
                }}
              >
                Time (s)
              </Text>
            </View>

            {/* Chart + X Axis */}
            <View style={{ flex: 1 }}>
              <LineChart
                style={{ height: 200 }}
                data={filteredGraphData}
                yAccessor={({ item }) => item.y}
                xAccessor={({ item }) => item.x}
                svg={{ stroke: 'rgb(34, 128, 176)', strokeWidth: 2 }}
                contentInset={{ top: 10, bottom: 10, left: 10, right: 10 }}
                xMin={-0.1}
                xMax={maxX}
                yMin={0}
                yMax={MAX_GRAPH_SECONDS}
                scale={scale.scaleLinear}
                numberOfTicks={MAX_GRAPH_SECONDS}
              >
                <Grid direction={Grid.Direction.HORIZONTAL} />
              </LineChart>

              <XAxis
                style={{ marginTop: 5 }}
                data={[...Array(5).keys()].map(i => -0.1 + (maxX + 0.1) * (i / 4))}
                formatLabel={(value) => value.toFixed(2)}
                svg={{ fontSize: 10, fill: 'black' }}
                scale={scale.scaleLinear}
                contentInset={{ left: 10, right: 10 }}
              />

              <Text style={{ textAlign: 'center', fontSize: 12, marginTop: 4 }}>Value (V)</Text>
            </View>
          </View>

          {/* Logging buttons */}
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
