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

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const baselineRef = useRef<number | null>(null);

  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);

  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [scanTime, setScanTime] = useState<number>(0);
  const scanTimerRef = useRef<NodeJS.Timer | null>(null);

  const [connectedTime, setConnectedTime] = useState<number>(0);
  const connectedTimerRef = useRef<NodeJS.Timer | null>(null);

  function updateBaseline(value: number) {
    baselineRef.current = value;
    setBaseline(value);
  }

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version < 31) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission Required',
            message: 'Location permission is needed to scan for BLE devices',
            buttonPositive: 'OK',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const grantedScan = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          {
            title: 'Bluetooth Scan Permission Required',
            message: 'Bluetooth scan permission is needed to find devices',
            buttonPositive: 'OK',
          }
        );
        const grantedConnect = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          {
            title: 'Bluetooth Connect Permission Required',
            message: 'Bluetooth connect permission is needed to connect to devices',
            buttonPositive: 'OK',
          }
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
    if (!permission) {
      setConnecting(false);
      return;
    }

    setScanTime(0);
    setConnecting(true);

    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    scanTimerRef.current = setInterval(() => {
      setScanTime((prev) => prev + 1);
    }, 1000);

    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        console.warn('Scan error:', error);
        bleManager.stopDeviceScan();
        setConnecting(false);
        clearInterval(scanTimerRef.current!);
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

          // Start connected timer
          setConnectedTime(0);
          connectedTimerRef.current = setInterval(() => {
            setConnectedTime((prev) => prev + 1);
          }, 1000);

          connected.onDisconnected(() => {
            ToastAndroid.show('Device disconnected', ToastAndroid.SHORT);
            disconnect();
          });
        } catch (e) {
          console.warn('Connection failed:', e);
          ToastAndroid.show('Connection failed', ToastAndroid.SHORT);
        }

        setConnecting(false);
      }
    });
  }

  function monitorNotifications(device: Device) {
    device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('Notification error:', error);
          disconnect();
          return;
        }

        if (characteristic?.value) {
          const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
          const isValid = /^[BV]-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(decoded);
          if (!isValid) return;

          const type = decoded.charAt(0);
          const [firstStr, secondStr] = decoded.slice(1).split(',');
          const firstFloat = parseFloat(firstStr);
          const secondFloat = parseFloat(secondStr);

          if (isNaN(firstFloat) || isNaN(secondFloat)) return;

          setReading(secondFloat);

          if (type === 'B') {
            updateBaseline(firstFloat);
          } else if (type === 'V') {
            setVref(firstFloat);
          }

          if (baselineRef.current !== null) {
            setValue(secondFloat - baselineRef.current);
          }
        }
      }
    );
  }

  async function disconnect() {
    if (connectedDevice) {
      try {
        await connectedDevice.cancelConnection();
      } catch (e) {
        console.warn('Disconnect error:', e);
      }
    }

    if (connectedTimerRef.current) clearInterval(connectedTimerRef.current);
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);

    setConnectedDevice(null);
    setBaseline(null);
    setVref(null);
    setReading(null);
    setValue(null);
    setConnecting(false);
    setConnectedTime(0);
    setScanTime(0);
  }

  useEffect(() => {
    return () => {
      bleManager.destroy();
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
      if (connectedTimerRef.current) clearInterval(connectedTimerRef.current);
    };
  }, []);

  return (
    <View style={styles.container}>
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
          <Text>Connected for: {connectedTime}s</Text>
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
            <Button title="Disconnect" onPress={disconnect} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
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
