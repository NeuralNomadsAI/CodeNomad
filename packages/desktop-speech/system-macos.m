#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

static const NSUInteger MaxText = 64 * 1024;

static void Emit(NSDictionary *frame) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static int Error(NSString *error) {
    Emit(@{@"error": error});
    return 0;
}

static NSString *LocaleTag(NSLocale *locale) {
    return [locale.localeIdentifier stringByReplacingOccurrencesOfString:@"_" withString:@"-"];
}

@interface Session : NSObject
@property(nonatomic) BOOL done;
@property(nonatomic) BOOL cancelled;
@property(nonatomic) BOOL finishing;
@property(nonatomic, strong) AVAudioEngine *audio;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *stream;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) NSString *text;
@property(nonatomic, strong) NSString *error;
- (void)finish;
- (void)cancel;
- (void)stopAudio;
@end

@implementation Session
- (void)stopAudio {
    if (!self.audio) return;
    [self.audio stop];
    [self.audio.inputNode removeTapOnBus:0];
    self.audio = nil;
}
- (void)finish {
    if (self.done || self.finishing) return;
    self.finishing = YES;
    [self stopAudio];
    [self.stream endAudio];
    Emit(@{@"progress": @{@"state": @"transcribing"}});
}
- (void)cancel {
    self.cancelled = YES;
    [self stopAudio];
    [self.task cancel];
    self.done = YES;
}
@end

// Callbacks publish on the main queue, including the pipe lease and both authorization replies.
static void RunUntil(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while (!done() && [limit timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]];
    }
}

static int Dictate(SFSpeechRecognizer *recognizer, NSString *clip) {
    Session *session = [Session new];
    if (!clip) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char input[32];
            if (fgets(input, sizeof(input), stdin) &&
                (!strcmp(input, "finish\n") || !strcmp(input, "finish\r\n"))) {
                dispatch_async(dispatch_get_main_queue(), ^{ [session finish]; });
                (void)fgets(input, sizeof(input), stdin);
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [session cancel]; });
        });
    }
    __block SFSpeechRecognizerAuthorizationStatus speech = SFSpeechRecognizer.authorizationStatus;
    if (speech == SFSpeechRecognizerAuthorizationStatusNotDetermined && !clip) {
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            dispatch_async(dispatch_get_main_queue(), ^{ speech = status; });
        }];
        RunUntil(^BOOL { return session.done || session.finishing || speech != SFSpeechRecognizerAuthorizationStatusNotDetermined; }, 30);
    }
    if (session.done || session.finishing) return Error(@"failed");
    if (speech != SFSpeechRecognizerAuthorizationStatusAuthorized) return Error(@"permissionDenied");

    if (!clip) {
        __block AVAuthorizationStatus mic = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        if (mic == AVAuthorizationStatusNotDetermined) {
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
                dispatch_async(dispatch_get_main_queue(), ^{ mic = allowed ? AVAuthorizationStatusAuthorized : AVAuthorizationStatusDenied; });
            }];
            RunUntil(^BOOL { return session.done || session.finishing || mic != AVAuthorizationStatusNotDetermined; }, 30);
        }
        if (session.done || session.finishing) return Error(@"failed");
        if (mic != AVAuthorizationStatusAuthorized) return Error(@"permissionDenied");
    }

    // Apple honors requiresOnDeviceRecognition only for a recognizer that supports it.
    if (!recognizer.supportsOnDeviceRecognition || !recognizer.available) return Error(@"localeUnavailable");
    SFSpeechRecognitionRequest *request;
    if (clip) {
        request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:[NSURL fileURLWithPath:clip]];
    } else {
        session.stream = [SFSpeechAudioBufferRecognitionRequest new];
        request = session.stream;
    }
    request.requiresOnDeviceRecognition = YES;
    request.shouldReportPartialResults = YES;
    request.taskHint = SFSpeechRecognitionTaskHintDictation;
    session.task = [recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (session.done) return;
            if (result.isFinal) session.text = result.bestTranscription.formattedString;
            else if (error) session.error = @"failed";
            else if (result && !session.finishing) {
                NSString *text = result.bestTranscription.formattedString;
                if (text && [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= MaxText)
                    Emit(@{@"progress": @{@"state": @"recording", @"text": text}});
            }
            if (result.isFinal || error) session.done = YES;
        });
    }];
    id deviceObserver = nil;
    if (!clip) {
        session.audio = [AVAudioEngine new];
        AVAudioInputNode *mic = session.audio.inputNode;
        AVAudioFormat *format = [mic outputFormatForBus:0];
        if (!format.channelCount || !format.sampleRate) {
            [session.task cancel];
            return Error(@"failed");
        }
        SFSpeechAudioBufferRecognitionRequest *stream = session.stream;
        [mic installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *time) {
            (void)time;
            [stream appendAudioPCMBuffer:buffer];
        }];
        deviceObserver = [NSNotificationCenter.defaultCenter addObserverForName:AVAudioEngineConfigurationChangeNotification
                object:session.audio queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            if (!session.finishing && !session.done) {
                session.error = @"failed";
                [session cancel];
            }
        }];
        if (![session.audio startAndReturnError:NULL]) {
            [NSNotificationCenter.defaultCenter removeObserver:deviceObserver];
            [session cancel];
            return Error(@"failed");
        }
        Emit(@{@"progress": @{@"state": @"recording"}});
    }
    RunUntil(^BOOL { return session.done || session.finishing; }, 120);
    if (!session.done && session.finishing) RunUntil(^BOOL { return session.done; }, 10);
    if (deviceObserver) [NSNotificationCenter.defaultCenter removeObserver:deviceObserver];
    [session stopAudio];
    if (!session.done || session.error || session.cancelled) {
        [session.task cancel];
        return Error(session.error ?: @"failed");
    }
    if ([session.text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > MaxText) return Error(@"failed");
    Emit(@{@"value": session.text ?: @""});
    return 0;
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        @try {
            if (argc == 2 && !strcmp(argv[1], "probe")) {
                NSMutableArray<NSString *> *locales = [NSMutableArray new];
                for (NSLocale *locale in SFSpeechRecognizer.supportedLocales) {
                    SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
                    if (recognizer.supportsOnDeviceRecognition && recognizer.available) [locales addObject:LocaleTag(locale)];
                }
                [locales sortUsingSelector:@selector(caseInsensitiveCompare:)];
                Emit(@{@"value": locales});
                return 0;
            }
            BOOL clip = argc == 4 && !strcmp(argv[1], "clip");
            if (!(clip || (argc == 3 && !strcmp(argv[1], "dictate")))) return Error(@"failed");
            NSString *tag = [NSString stringWithUTF8String:argv[2]];
            for (NSLocale *locale in SFSpeechRecognizer.supportedLocales) {
                if ([LocaleTag(locale) caseInsensitiveCompare:tag] != NSOrderedSame) continue;
                SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
                if (!recognizer.supportsOnDeviceRecognition || !recognizer.available) break;
                return Dictate(recognizer, clip ? [NSString stringWithUTF8String:argv[3]] : nil);
            }
            return Error(@"localeUnavailable");
        } @catch (NSException *exception) {
            return Error(@"failed");
        }
    }
}
